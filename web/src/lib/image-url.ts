export function thumbnailUrlForImageUrl(value: string | undefined) {
  const url = String(value || "");
  if (!url || !url.includes("/images/")) {
    return url;
  }
  return url.replace("/images/", "/image-thumbnails/");
}
