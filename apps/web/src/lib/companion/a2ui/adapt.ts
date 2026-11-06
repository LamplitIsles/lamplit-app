import {
  validateA2UISurface,
  workspaceMediaUrl,
  type A2UISurface,
  type WorkspaceMediaKind,
} from "@lamplit/contracts";
import type { AgentToRenderer } from "svelte-a2ui";

/** Convert only the documented dynamic-value locations to the renderer dialect. */
export function adaptSurface(
  input: unknown,
  nativeMedia = false,
): {
  message: AgentToRenderer;
  surfaceId: string;
} {
  const surface: A2UISurface = validateA2UISurface(input);
  const binding = (value: unknown): unknown => {
    if (value && typeof value === "object" && "@path" in value) {
      return { path: (value as { "@path": string })["@path"] };
    }
    return value;
  };
  const components = surface.createSurface.components.map((node) => {
    const adapted: Record<string, unknown> = { ...node };
    const mediaURL = (value: string, kind: WorkspaceMediaKind) => {
      const workspace = value.startsWith("workspace:")
        ? workspaceMediaUrl(value, kind)
        : null;
      if (value.startsWith("workspace:") && workspace === null)
        throw new Error("Invalid workspace media");
      const resolved = workspace ?? value;
      const url = new URL(resolved, window.location.origin);
      const approved =
        /^\/api\/chat\/media\/[A-Za-z0-9_-]{1,100}\/(?:original|preview|model)$|^\/api\/audio\/[0-9a-f]{64}\.mp3$/;
      if (url.origin !== window.location.origin) return resolved;
      if (
        url.pathname !== "/api/chat/workspace-image" &&
        url.pathname !== "/api/chat/workspace-media"
      )
        return nativeMedia &&
          !url.hash &&
          !url.search &&
          approved.test(url.pathname)
          ? `cfl-media://load/${encodeURIComponent(url.pathname)}`
          : resolved;
      const params = url.searchParams;
      const image = url.pathname === "/api/chat/workspace-image";
      const expectedKeys = image ? ["path"] : ["kind", "path"];
      if (
        url.hash ||
        [...params.keys()].length !== expectedKeys.length ||
        expectedKeys.some((key) => params.getAll(key).length !== 1) ||
        (image
          ? kind !== "image"
          : kind === "image" || params.get("kind") !== kind)
      )
        throw new Error("Invalid workspace media URL");
      const path = params.get("path")!;
      const canonical = workspaceMediaUrl(
        `workspace:${encodeURIComponent(path)}`,
        kind,
      );
      if (!canonical) throw new Error("Invalid workspace media URL");
      return nativeMedia
        ? `cfl-media://load/${encodeURIComponent(canonical)}`
        : canonical;
    };
    if (
      node.component === "Image" ||
      node.component === "Video" ||
      node.component === "AudioPlayer"
    )
      adapted.url = mediaURL(
        node.url,
        node.component === "Image"
          ? "image"
          : node.component === "Video"
            ? "video"
            : "audio",
      );
    if (node.component === "Video" && node.posterUrl !== undefined)
      adapted.posterUrl = mediaURL(node.posterUrl, "image");
    if ("text" in node) adapted.text = binding(node.text);
    if ("description" in node) adapted.description = binding(node.description);
    if (node.component === "Tabs")
      adapted.tabs = node.tabs.map((tab) => ({
        ...tab,
        title: binding(tab.title),
      }));
    if (node.accessibility) {
      const { label, description, live } = node.accessibility;
      adapted.accessibility = {
        label: binding(label),
        description: binding(description),
        live,
      };
      const resolveText = (value: unknown): string | undefined => {
        if (typeof value === "string") return value;
        if (value && typeof value === "object" && "@path" in value)
          return surface.createSurface.dataModel?.[
            String((value as { "@path": string })["@path"]).slice(1)
          ];
      };
      const accessible = resolveText(label);
      if (accessible) adapted.ariaLabel = accessible;
    }
    return adapted;
  });
  return {
    message: {
      version: "v1.0",
      createSurface: { ...surface.createSurface, components },
    } as unknown as AgentToRenderer,
    surfaceId: surface.createSurface.surfaceId,
  };
}
