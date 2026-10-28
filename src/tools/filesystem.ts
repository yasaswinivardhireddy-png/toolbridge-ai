import { lstat, open, readdir, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_FILE_BYTES = 64 * 1024;
const MAX_ENTRIES = 200;

export class Workspace {
  constructor(private readonly root: string) {}

  private async target(relative: string): Promise<string> {
    const components = relative.split(/[\\/]/);
    if (!relative || /[\u0000-\u001f:<>|"?*]/.test(relative) || path.isAbsolute(relative)
      || relative.startsWith("\\") || relative.startsWith("/")
      || components.some(part => part === ".." || (part !== "." && /[. ]$/.test(part))
        || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(part))) {
      throw new Error("Provide a relative workspace path.");
    }
    const root = await realpath(this.root);
    const target = path.resolve(root, ...components);
    const fromRoot = path.relative(root, target);
    if (fromRoot === ".." || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
      throw new Error("Path escapes the workspace.");
    }
    let current = root;
    for (const component of fromRoot.split(path.sep).filter(Boolean)) {
      current = path.join(current, component);
      try {
        const info = await lstat(current);
        if (info.isSymbolicLink()) {
          throw new Error("Symbolic links and junctions are not allowed.");
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
          throw error;
        }
      }
    }
    return target;
  }

  async list(relative = "."): Promise<unknown> {
    const entries = await readdir(await this.target(relative), { withFileTypes: true });
    return {
      path: relative,
      entries: entries.slice(0, MAX_ENTRIES).map(entry => ({
        name: entry.name,
        kind: entry.isSymbolicLink() ? "blocked-link" : entry.isDirectory() ? "directory" : "file"
      })),
      truncated: entries.length > MAX_ENTRIES
    };
  }

  async read(relative: string): Promise<unknown> {
    const file = await open(await this.target(relative), "r");
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        throw new Error("Only regular UTF-8 files up to 64 KiB can be read.");
      }
      const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > MAX_FILE_BYTES) {
        throw new Error("File exceeds the 64 KiB limit.");
      }
      return { path: relative, content: new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead)) };
    } finally {
      await file.close();
    }
  }

  async write(relative: string, content: string): Promise<unknown> {
    if (Buffer.byteLength(content, "utf8") > MAX_FILE_BYTES) {
      throw new Error("File exceeds the 64 KiB limit.");
    }
    // Exclusive creation prevents accidental overwrites; the app has no delete tool.
    const file = await open(await this.target(relative), "wx");
    try {
      await file.writeFile(content, "utf8");
    } finally {
      await file.close();
    }
    return { path: relative, bytesWritten: Buffer.byteLength(content, "utf8") };
  }
}
