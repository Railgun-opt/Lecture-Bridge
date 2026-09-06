import type { TranscriptSegment } from "../types";

function pad(value: number, size = 2): string {
  return String(value).padStart(size, "0");
}

function srtTime(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const hours = Math.floor(safe / 3_600_000);
  const minutes = Math.floor((safe % 3_600_000) / 60_000);
  const seconds = Math.floor((safe % 60_000) / 1_000);
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)},${pad(safe % 1_000, 3)}`;
}

function timestamp(ms: number): string {
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  return `${pad(minutes)}:${pad(seconds)}`;
}

function clean(segments: TranscriptSegment[]): TranscriptSegment[] {
  return segments.filter((segment) => segment.source.trim() || segment.translation.trim());
}

export function exportMarkdown(segments: TranscriptSegment[]): void {
  download(markdownDocument(segments), `lecture-${dateSlug()}.md`, "text/markdown;charset=utf-8");
}

export function markdownDocument(segments: TranscriptSegment[]): string {
  const rows = clean(segments);
  return [
    "# Lecture Bridge 课堂字幕",
    "",
    `导出时间：${new Date().toLocaleString("zh-CN")}`,
    "",
    ...rows.flatMap((segment) => [
      `## ${timestamp(segment.startedMs)}`,
      "",
      segment.source ? `**EN** ${segment.source.trim()}` : "",
      "",
      segment.translation ? `**中文** ${segment.translation.trim()}` : "",
      "",
    ]),
  ].join("\n");
}

export function exportSrt(segments: TranscriptSegment[]): void {
  const rows = clean(segments);
  const body = rows
    .map((segment, index) => {
      const next = rows[index + 1]?.startedMs ?? segment.startedMs + 5_000;
      const end = Math.max(segment.startedMs + 1_200, next - 80);
      return [
        String(index + 1),
        `${srtTime(segment.startedMs)} --> ${srtTime(end)}`,
        segment.source.trim(),
        segment.translation.trim(),
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n\n");
  download(body, `lecture-${dateSlug()}.srt`, "application/x-subrip;charset=utf-8");
}

function download(content: string, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}

function dateSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
