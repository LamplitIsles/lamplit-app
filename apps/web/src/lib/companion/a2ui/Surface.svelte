<script lang="ts">
  import {
    A2uiClient,
    Surface,
    basicCatalog,
    createCatalogRegistry,
    createMockTransport,
    type CatalogEntry,
  } from "svelte-a2ui";
  import "svelte-a2ui/theme.css";
  import { adaptSurface } from "./adapt.js";
  import { setContext, tick, untrack } from "svelte";
  import Text from "./Text.svelte";
  import Media from "./Media.svelte";
  import LocalButton from "./LocalButton.svelte";
  import LocalModal from "./LocalModal.svelte";
  import AccessibleNode from "./AccessibleNode.svelte";
  let {
    payload,
    locale = "en",
    nativeMedia = false,
    onModalChange = () => {},
  }: {
    payload: unknown;
    locale?: string;
    nativeMedia?: boolean;
    onModalChange?: (open: boolean) => void;
  } = $props();
  setContext("a2ui-locale", () => locale);
  const openModals = new Set<string>();
  setContext("a2ui-modal-state", (id: string, open: boolean) => {
    if (open) openModals.add(id);
    else openModals.delete(id);
    onModalChange(openModals.size > 0);
  });
  const closeModals = new Set<() => void>();
  setContext("a2ui-modal-registration", (close: () => void) => {
    closeModals.add(close);
    return () => {
      closeModals.delete(close);
    };
  });
  const components: Record<string, CatalogEntry> = {
    Icon: basicCatalog.components.Icon!,
    Row: basicCatalog.components.Row!,
    Column: basicCatalog.components.Column!,
    List: basicCatalog.components.List!,
    Card: basicCatalog.components.Card!,
    Tabs: basicCatalog.components.Tabs!,
    Divider: basicCatalog.components.Divider!,
    Text: { component: Text },
    Image: { component: Media },
    Video: { component: Media },
    AudioPlayer: { component: Media },
    Button: { component: LocalButton, slots: { child: "child" } },
    Modal: {
      component: LocalModal,
      slots: { trigger: "child", content: "child" },
    },
  };
  setContext(
    "a2ui-original-components",
    Object.fromEntries(
      Object.entries(components).map(([name, entry]) => [
        name,
        entry.component,
      ]),
    ),
  );
  const wrapped = Object.fromEntries(
    Object.entries(components).map(([name, entry]) => [
      name,
      { ...entry, component: AccessibleNode },
    ]),
  );
  const catalog = createCatalogRegistry(
    [{ ...basicCatalog, components: wrapped }],
    { strict: true },
  );
  let state = $state<{
    client: A2uiClient;
    surfaceId: string;
  } | null>(null);
  $effect(() => {
    const input = payload;
    const native = nativeMedia;
    return untrack(() => {
      try {
        const { message, surfaceId } = adaptSurface(input, native);
        const client = new A2uiClient({
          transport: createMockTransport([message]),
        });
        state = { client, surfaceId };
        void client.start();
        return () => {
          for (const close of closeModals) close();
          // The child renderer must unmount before its backing surface is cleared.
          void tick().then(() => client.destroy());
        };
      } catch {
        state = null;
      }
    });
  });
</script>

{#each state ? [state] : [] as current (current)}<div class="a2ui-surface">
    <Surface
      client={current.client}
      {catalog}
      surfaceId={current.surfaceId}
      maxDepth={16}
    />
  </div>{:else}<div class="a2ui-unavailable" role="status">
    {locale === "zh" ? "界面暂时无法显示" : "Unable to display this interface"}
  </div>{/each}

<style>
  .a2ui-surface {
    min-width: 0;
    max-width: 100%;
    color: var(--f7-text-color);
    --a2ui-color-text: var(--f7-text-color);
    --a2ui-color-text-muted: var(--f7-text-color);
    --a2ui-color-primary: var(--f7-theme-color);
    --a2ui-color-surface: var(--f7-page-bg-color);
    --a2ui-color-surface-raised: var(--f7-card-bg-color);
    --a2ui-color-border: var(--f7-bars-border-color);
  }
  .a2ui-unavailable {
    opacity: 0.7;
    font-size: 0.875rem;
    padding: 0.6rem;
  }
</style>
