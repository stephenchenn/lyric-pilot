import { spawn } from "node:child_process";

export async function runProcess(command: string, args: string[], options: {
  signal?: AbortSignal; timeoutMs?: number; maxOutputBytes?: number;
} = {}): Promise<{ stdout: Buffer; stderr: string }> {
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 120_000);
  const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], signal, killSignal: "SIGKILL" });
    const output: Buffer[] = [];
    let size = 0, stderr = "", exceeded = false;
    child.stdout.on("data", (data: Buffer) => {
      size += data.length;
      if (size > (options.maxOutputBytes ?? 1_048_576)) { exceeded = true; child.kill("SIGKILL"); }
      else output.push(data);
    });
    child.stderr.on("data", data => { stderr = (stderr + String(data)).slice(-16_384); });
    child.once("error", error => reject(new Error(`${command}: ${error.message}`)));
    child.once("close", code => {
      if (exceeded) reject(new Error(`${command}: output limit exceeded`));
      else if (signal.aborted) reject(new Error(`${command}: cancelled or timed out`));
      else if (code !== 0) reject(new Error(`${command} exited ${code}: ${stderr.trim()}`));
      else resolve({ stdout: Buffer.concat(output), stderr });
    });
  });
}
