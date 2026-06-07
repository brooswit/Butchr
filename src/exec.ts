// Thin wrapper around Bun.spawn for shelling out to git / herdr.
export type ExecResult = {
  code: number;
  stdout: string;
  stderr: string;
  ok: boolean;
};

export async function run(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr, ok: code === 0 };
}

/** Like run(), but throws on non-zero exit with a useful message. */
export async function runOrThrow(
  cmd: string[],
  opts: { cwd?: string } = {},
): Promise<ExecResult> {
  const res = await run(cmd, opts);
  if (!res.ok) {
    throw new Error(
      `command failed (${res.code}): ${cmd.join(" ")}\n${res.stderr || res.stdout}`,
    );
  }
  return res;
}
