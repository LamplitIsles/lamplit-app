/** Fetch through the authenticated web session, then save original bytes. */
export async function saveImage(url: string, filename: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw new Error("Image unavailable");
  const blob = await response.blob();
  const name = filename.replace(/[\\/:*?"<>|]/g, "-").trim() || "image";
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = /\.[a-z\d]+$/i.test(name)
    ? name
    : `${name}.${blob.type.split("/")[1]?.replace("jpeg", "jpg") || "png"}`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 60_000);
}
