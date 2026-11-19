import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".venv", "__pycache__", ".cache"]);
const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".bmp", ".svgz",
  ".exe", ".dll", ".so", ".dylib", ".bin", ".dat", ".pak", ".asar",
  ".zip", ".7z", ".rar", ".tar", ".gz", ".zst", ".pdf", ".woff", ".woff2", ".ttf",
  ".mp3", ".mp4", ".wav", ".ogg", ".webm", ".avi", ".upk", ".uasset"
]);

const DANGEROUS_PATTERNS = [
  /\brm\s+-rf\s+\/(\s|$)/i,
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\bRemove-Item\b[^\n]*-Recurse[^\n]*\b[a-z]:\\(\s|"|'|$)/i,
  /\b(del|erase|rd|rmdir)\b[^\n]*\/[sq][^\n]*\b[a-z]:\\(\s|"|'|$)/i,
  /\breg\s+delete\s+HK(LM|CU|CR)\\/i
];

export function resolveSafePath(cwd, targetPath = ".", allowOutside = false) {
  const root = path.resolve(cwd);
  const target = String(targetPath || ".").trim() || ".";
  const resolved = path.resolve(root, target);
  if (!allowOutside) {
    const isWin = process.platform === "win32";
    const normRoot = isWin ? root.toLowerCase() : root;
    const normResolved = isWin ? resolved.toLowerCase() : resolved;
    const rootWithSep = normRoot.endsWith(path.sep) ? normRoot : normRoot + path.sep;
    if (normResolved !== normRoot && !normResolved.startsWith(rootWithSep)) {
      throw new Error(`路径越界被拒绝：${targetPath} 不在工作区 ${root} 内`);
    }
  }
  return resolved;
}

function toRelOrAbs(cwd, absPath) {
  const rel = path.relative(cwd, absPath);
  if (rel && !rel.startsWith("..") && !path.isAbsolute(rel)) {
    return rel.replace(/\\/g, "/");
  }
  return absPath;
}

function truncateText(text, maxChars = 12000) {
  const s = String(text || "");
  if (s.length <= maxChars) return s;
  return s.slice(0, maxChars) + `\n... [已截断，共 ${s.length} 字符]`;
}

function execListDir(cwd, args, allowOutside) {
  const targetDir = resolveSafePath(cwd, args.path || ".", allowOutside);
  if (!fs.existsSync(targetDir)) throw new Error(`目录不存在：${args.path || "."}`);
  const stat = fs.statSync(targetDir);
  if (!stat.isDirectory()) throw new Error(`目标不是目录：${args.path || "."}`);

  const maxDepth = Math.max(1, Math.min(4, Number(args.max_depth) || 2));
  const entries = [];
  const MAX_ENTRIES = 200;

  function walk(dir, depth) {
    if (entries.length >= MAX_ENTRIES) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    items.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    for (const item of items) {
      if (entries.length >= MAX_ENTRIES) break;
      if (item.isDirectory() && SKIP_DIRS.has(item.name)) continue;
      const full = path.join(dir, item.name);
      const rel = toRelOrAbs(cwd, full);
      if (item.isDirectory()) {
        entries.push({ path: rel + "/", type: "dir" });
        if (depth < maxDepth) walk(full, depth + 1);
      } else {
        let size = 0;
        try {
          size = fs.statSync(full).size;
        } catch {}
        entries.push({ path: rel, type: "file", size });
      }
    }
  }

  walk(targetDir, 1);
  return {
    root: toRelOrAbs(cwd, targetDir) || ".",
    truncated: entries.length >= MAX_ENTRIES,
    entries
  };
}

function execReadFile(cwd, args, allowOutside) {
  if (!args.path) throw new Error("缺少 path 参数");
  const filePath = resolveSafePath(cwd, args.path, allowOutside);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${args.path}`);
  const stat = fs.statSync(filePath);
  if (stat.isDirectory()) throw new Error(`目标是目录而非文件：${args.path}`);
  if (stat.size > 2 * 1024 * 1024) {
    throw new Error(`文件过大 (${stat.size} bytes)，请使用 search_files 定位后再读取`);
  }

  const raw = fs.readFileSync(filePath, "utf8");
  const lines = raw.split(/\r?\n/);
  const totalLines = lines.length;
  const startLine = Math.max(1, Number(args.start_line) || 1);
  const requestedEnd = Number(args.end_line) || (startLine + 249);
  const endLine = Math.min(totalLines, Math.min(startLine + 299, Math.max(startLine, requestedEnd)));

  const outLines = [];
  let charCount = 0;
  let actualEnd = startLine - 1;
  for (let ln = startLine; ln <= endLine; ln++) {
    const formatted = `${ln}: ${lines[ln - 1]}`;
    if (charCount + formatted.length > 24576 && outLines.length > 0) break;
    outLines.push(formatted);
    charCount += formatted.length + 1;
    actualEnd = ln;
  }

  return {
    path: toRelOrAbs(cwd, filePath),
    totalLines,
    startLine,
    endLine: actualEnd,
    truncated: actualEnd < totalLines,
    content: outLines.join("\n")
  };
}

function execSearchFiles(cwd, args, allowOutside) {
  const query = String(args.query || "");
  if (!query) throw new Error("缺少 query 参数");
  const targetPath = resolveSafePath(cwd, args.path || ".", allowOutside);
  if (!fs.existsSync(targetPath)) throw new Error(`搜索路径不存在：${args.path || "."}`);

  const extFilter = Array.isArray(args.extensions) && args.extensions.length > 0
    ? new Set(args.extensions.map((e) => (e.startsWith(".") ? e.toLowerCase() : "." + e.toLowerCase())))
    : null;

  const matches = [];
  const MAX_MATCHES = 40;
  const qLower = query.toLowerCase();

  function scanFile(filePath) {
    if (matches.length >= MAX_MATCHES) return;
    const ext = path.extname(filePath).toLowerCase();
    if (BINARY_EXTS.has(ext)) return;
    if (extFilter && !extFilter.has(ext)) return;
    let stat;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return;
    }
    if (!stat.isFile() || stat.size > 512 * 1024) return;
    let content;
    try {
      content = fs.readFileSync(filePath, "utf8");
    } catch {
      return;
    }
    if (content.includes("\u0000")) return;
    const lines = content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].toLowerCase().includes(qLower)) {
        matches.push({
          file: toRelOrAbs(cwd, filePath),
          line: i + 1,
          text: lines[i].trim().slice(0, 220)
        });
        if (matches.length >= MAX_MATCHES) break;
      }
    }
  }

  function walk(p) {
    if (matches.length >= MAX_MATCHES) return;
    let stat;
    try {
      stat = fs.statSync(p);
    } catch {
      return;
    }
    if (stat.isFile()) {
      scanFile(p);
      return;
    }
    if (!stat.isDirectory()) return;
    let items;
    try {
      items = fs.readdirSync(p, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      if (matches.length >= MAX_MATCHES) break;
      if (item.isDirectory()) {
        if (SKIP_DIRS.has(item.name)) continue;
        walk(path.join(p, item.name));
      } else {
        scanFile(path.join(p, item.name));
      }
    }
  }

  walk(targetPath);
  return {
    query,
    count: matches.length,
    truncated: matches.length >= MAX_MATCHES,
    matches
  };
}

function execWriteFile(cwd, args, allowOutside, tracker) {
  if (!args.path) throw new Error("缺少 path 参数");
  if (args.content === undefined || args.content === null) throw new Error("缺少 content 参数");
  const filePath = resolveSafePath(cwd, args.path, allowOutside);
  const existed = fs.existsSync(filePath);
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const text = String(args.content);
  fs.writeFileSync(filePath, text, "utf8");

  const label = toRelOrAbs(cwd, filePath);
  if (!existed) {
    if (!tracker.createdFiles.includes(label)) tracker.createdFiles.push(label);
  } else if (!tracker.createdFiles.includes(label) && !tracker.modifiedFiles.includes(label)) {
    tracker.modifiedFiles.push(label);
  }
  return { ok: true, action: existed ? "overwritten" : "created", path: label, bytes: Buffer.byteLength(text, "utf8") };
}

function execEditFile(cwd, args, allowOutside, tracker) {
  if (!args.path) throw new Error("缺少 path 参数");
  if (args.target === undefined || args.target === null || args.target === "") {
    throw new Error("缺少 target 参数（需要匹配的非空原文本）");
  }
  if (args.replacement === undefined || args.replacement === null) {
    throw new Error("缺少 replacement 参数");
  }
  const filePath = resolveSafePath(cwd, args.path, allowOutside);
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在：${args.path}`);

  const raw = fs.readFileSync(filePath, "utf8");
  const target = String(args.target);
  const replacement = String(args.replacement);
  const replaceAll = Boolean(args.replace_all);

  // Normalize line endings if exact match misses purely due to CRLF vs LF
  let actualTarget = target;
  let actualReplacement = replacement;
  if (!raw.includes(actualTarget) && raw.includes("\r\n") && !target.includes("\r\n")) {
    const crlfTarget = target.replace(/\n/g, "\r\n");
    if (raw.includes(crlfTarget)) {
      actualTarget = crlfTarget;
      actualReplacement = replacement.replace(/\r?\n/g, "\r\n");
    }
  }

  let count = 0;
  let idx = raw.indexOf(actualTarget);
  while (idx !== -1) {
    count++;
    idx = raw.indexOf(actualTarget, idx + actualTarget.length);
  }

  if (count === 0) {
    throw new Error(`未在 ${args.path} 中找到精确匹配的 target 文本，请先 read_file 确认上下文`);
  }
  if (count > 1 && !replaceAll) {
    throw new Error(`在 ${args.path} 中找到 ${count} 处匹配，请补充更多上下文使匹配唯一，或设置 replace_all=true`);
  }

  const nextContent = replaceAll
    ? raw.split(actualTarget).join(actualReplacement)
    : raw.replace(actualTarget, actualReplacement);

  fs.writeFileSync(filePath, nextContent, "utf8");
  const label = toRelOrAbs(cwd, filePath);
  if (!tracker.createdFiles.includes(label) && !tracker.modifiedFiles.includes(label)) {
    tracker.modifiedFiles.push(label);
  }
  return { ok: true, path: label, replacements: replaceAll ? count : 1 };
}

function execRunCommand(cwd, args, defaultTimeoutMs) {
  const command = String(args.command || "").trim();
  if (!command) throw new Error("缺少 command 参数");
  for (const pat of DANGEROUS_PATTERNS) {
    if (pat.test(command)) {
      throw new Error(`命令命中高危防护规则，已拦截执行：${command}`);
    }
  }
  const timeoutMs = Math.max(2000, Math.min(120000, Number(args.timeout_ms) || defaultTimeoutMs || 60000));

  return new Promise((resolve) => {
    const shellCmd = process.platform === "win32" ? "powershell.exe" : "sh";
    const shellArgs = process.platform === "win32"
      ? ["-NoProfile", "-NonInteractive", "-Command", command]
      : ["-c", command];

    const child = spawn(shellCmd, shellArgs, {
      cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {}
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      if (stdout.length < 20000) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < 20000) stderr += chunk.toString("utf8");
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({
        exitCode: timedOut ? -1 : (code ?? 0),
        timedOut,
        stdout: truncateText(stdout, 12000),
        stderr: truncateText(stderr, 12000)
      });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({
        exitCode: -1,
        timedOut: false,
        stdout: "",
        stderr: err?.message || String(err)
      });
    });
  });
}

const ALL_TOOL_DEFS = {
  list_dir: {
    type: "function",
    function: {
      name: "list_dir",
      description: "列出工作区或子目录下的文件和文件夹（自动跳过 node_modules 和 .git）。",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "相对 cwd 的目录路径，默认 '.'" },
          max_depth: { type: "number", description: "递归深度 1-4，默认 2" }
        }
      }
    }
  },
  read_file: {
    type: "function",
    function: {
      name: "read_file",
      description: "按行号范围读取文本文件内容（单次最多 300 行）。",
      parameters: {
        type: "object",
        required: ["path"],
        properties: {
          path: { type: "string", description: "文件路径" },
          start_line: { type: "number", description: "起始行号（从 1 开始）" },
          end_line: { type: "number", description: "结束行号（包含）" }
        }
      }
    }
  },
  search_files: {
    type: "function",
    function: {
      name: "search_files",
      description: "在目录中递归检索包含指定关键词的文本文件及行号。",
      parameters: {
        type: "object",
        required: ["query"],
        properties: {
          query: { type: "string", description: "要搜索的文本（不区分大小写）" },
          path: { type: "string", description: "搜索根路径，默认 '.'" },
          extensions: { type: "array", items: { type: "string" }, description: "可选扩展名过滤，如 ['.js', '.ts']" }
        }
      }
    }
  },
  write_file: {
    type: "function",
    function: {
      name: "write_file",
      description: "创建新文件或完整覆盖写入文件内容（自动创建父目录）。",
      parameters: {
        type: "object",
        required: ["path", "content"],
        properties: {
          path: { type: "string", description: "文件路径" },
          content: { type: "string", description: "完整文件内容" }
        }
      }
    }
  },
  edit_file: {
    type: "function",
    function: {
      name: "edit_file",
      description: "对已有文件进行精确字符串替换修改。",
      parameters: {
        type: "object",
        required: ["path", "target", "replacement"],
        properties: {
          path: { type: "string", description: "文件路径" },
          target: { type: "string", description: "要替换的精确原文本" },
          replacement: { type: "string", description: "替换后的新文本" },
          replace_all: { type: "boolean", description: "是否替换全部匹配项，默认 false" }
        }
      }
    }
  },
  run_command: {
    type: "function",
    function: {
      name: "run_command",
      description: "在工作区目录下执行 PowerShell/Shell 命令（用于运行测试、检查或构建）。",
      parameters: {
        type: "object",
        required: ["command"],
        properties: {
          command: { type: "string", description: "要执行的命令" },
          timeout_ms: { type: "number", description: "超时毫秒数（上限 120000）" }
        }
      }
    }
  }
};

export function getWorkerToolSchemas(mode = "edit") {
  const names = ["list_dir", "read_file", "search_files"];
  if (mode === "edit" || mode === "full") {
    names.push("write_file", "edit_file");
  }
  if (mode === "full") {
    names.push("run_command");
  }
  return names.map((n) => ALL_TOOL_DEFS[n]);
}

export async function runWorkerTool({ name, args, cwd, mode, workerConfig, tracker }) {
  const allowOutside = Boolean(workerConfig?.allowOutsideWorkspace);
  const allowed = new Set(getWorkerToolSchemas(mode).map((t) => t.function.name));
  if (!allowed.has(name)) {
    throw new Error(`当前模式 (${mode}) 不允许调用工具：${name}`);
  }
  switch (name) {
    case "list_dir":
      return execListDir(cwd, args || {}, allowOutside);
    case "read_file":
      return execReadFile(cwd, args || {}, allowOutside);
    case "search_files":
      return execSearchFiles(cwd, args || {}, allowOutside);
    case "write_file":
      return execWriteFile(cwd, args || {}, allowOutside, tracker);
    case "edit_file":
      return execEditFile(cwd, args || {}, allowOutside, tracker);
    case "run_command":
      return execRunCommand(cwd, args || {}, workerConfig?.commandTimeoutMs || 60000);
    default:
      throw new Error(`未知工具：${name}`);
  }
}
