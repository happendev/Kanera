export function attachmentIconClass(mimeType: string, fileName: string): string {
  const mime = mimeType.toLowerCase();
  const ext = fileName.split(".").pop()?.toLowerCase() ?? "";

  if (mime.startsWith("image/")) return "ti-photo";
  if (mime.startsWith("video/")) return "ti-video";
  if (mime.startsWith("audio/")) return "ti-music";
  if (mime === "application/pdf" || ext === "pdf") return "ti-file-type-pdf";
  if (mime.includes("zip") || mime.includes("compressed") || ["7z", "br", "bz2", "gz", "rar", "tar", "tgz", "zip"].includes(ext)) {
    return "ti-file-zip";
  }
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["csv", "ods", "xls", "xlsm", "xlsx"].includes(ext)) {
    return "ti-file-type-xls";
  }
  if (mime.includes("presentation") || mime.includes("powerpoint") || ["key", "odp", "pps", "ppt", "pptx"].includes(ext)) {
    return "ti-file-type-ppt";
  }
  if (mime.includes("wordprocessing") || mime.includes("msword") || ["doc", "docx", "odt", "rtf"].includes(ext)) {
    return "ti-file-type-doc";
  }
  if (mime.startsWith("text/") || ["md", "markdown", "txt"].includes(ext)) return "ti-file-text";
  if (["css", "html", "js", "json", "jsx", "ts", "tsx", "xml", "yml", "yaml"].includes(ext)) return "ti-file-code";

  return "ti-file";
}
