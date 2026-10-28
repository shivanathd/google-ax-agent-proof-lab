// Actual decode checks with the pinned host FFmpeg (ffprobe/ffmpeg 6.0): file signature, full decode,
// dimensions, frame count, duration and frame rate. Extensions and manifest claims are never trusted.
import { spawnSync } from "node:child_process";
import { existsSync, openSync, readSync, closeSync, statSync } from "node:fs";

export interface MediaFacts {
  exists: boolean; bytes: number; signature: "png" | "gif" | "mp4" | "unknown"; decoded: boolean;
  width: number; height: number; frame_count: number; duration_ms: number; fps: number; error: string | null;
}

function magic(path: string): MediaFacts["signature"] {
  const fd = openSync(path, "r");
  const b = Buffer.alloc(12);
  readSync(fd, b, 0, 12, 0);
  closeSync(fd);
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (/^GIF8[79]a$/.test(b.subarray(0, 6).toString("latin1"))) return "gif";
  if (b.subarray(4, 8).toString("latin1") === "ftyp") return "mp4";
  return "unknown";
}

const rate = (r?: string) => {
  const [n, d] = String(r ?? "0/1").split("/").map(Number);
  return d ? n! / d : 0;
};

export function inspectMedia(path: string): MediaFacts {
  const none: MediaFacts = { exists: false, bytes: 0, signature: "unknown", decoded: false, width: 0, height: 0, frame_count: 0, duration_ms: 0, fps: 0, error: "file missing" };
  if (!existsSync(path)) return none;
  const facts: MediaFacts = { ...none, exists: true, bytes: statSync(path).size, signature: magic(path), error: null };
  const probe = spawnSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries",
    "stream=width,height,nb_read_frames,avg_frame_rate,r_frame_rate:format=duration", "-of", "json", path], { encoding: "utf8" });
  if (probe.status !== 0) return { ...facts, error: `ffprobe: ${(probe.stderr || "failed").trim().slice(0, 160)}` };
  const j = JSON.parse(probe.stdout);
  const s = j.streams?.[0] ?? {};
  // A full decode to the null muxer: any corrupt frame makes ffmpeg print an error.
  const decode = spawnSync("ffmpeg", ["-v", "error", "-xerror", "-i", path, "-f", "null", "-"], { encoding: "utf8" });
  const frames = Number(s.nb_read_frames ?? 0);
  const duration = Number(j.format?.duration ?? 0);
  return {
    ...facts, decoded: decode.status === 0 && !decode.stderr.trim(), width: Number(s.width ?? 0), height: Number(s.height ?? 0), frame_count: frames,
    duration_ms: Number.isFinite(duration) ? Math.round(duration * 1000) : 0,
    fps: duration > 0 && frames > 1 ? Math.round((frames / duration) * 100) / 100 : rate(s.avg_frame_rate),
    error: decode.status === 0 ? null : `decode: ${decode.stderr.trim().slice(0, 160)}`,
  };
}

export function toolVersions() {
  const v = (cmd: string, args: string[]) => {
    const r = spawnSync(cmd, args, { encoding: "utf8" });
    return r.status === 0 ? r.stdout.split("\n")[0]!.trim() : null;
  };
  return { ffmpeg: v("ffmpeg", ["-version"])?.replace(/ Copyright.*$/, "") ?? null, ffprobe: v("ffprobe", ["-version"])?.replace(/ Copyright.*$/, "") ?? null };
}
