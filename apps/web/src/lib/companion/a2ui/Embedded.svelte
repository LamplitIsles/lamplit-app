<script lang="ts">
  import { onMount } from "svelte";
  import { App, View } from "framework7-svelte";
  import Surface from "./Surface.svelte";
  let payload = $state<unknown>();
  let locale = $state("en");
  let container = $state<HTMLElement>();
  let modalOpen = false;
  let modalHeight = 480;
  let reportHeight = () => {};
  let payloadKey: string | undefined;
  function keyFor(value: unknown): string | undefined {
    try {
      return JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? Object.fromEntries(
              Object.keys(item)
                .sort()
                .map((key) => [key, item[key]]),
            )
          : item,
      );
    } catch {
      return undefined;
    }
  }
  type BridgeWindow = Window & {
    a2uiHost?: {
      show: (
        value: unknown,
        options?: {
          locale?: string;
          dark?: boolean;
          fontScale?: number;
          viewportHeight?: number;
        },
      ) => void;
    };
    webkit?: {
      messageHandlers?: {
        a2uiHeight?: { postMessage: (value: number) => void };
        a2uiReady?: { postMessage: (value: string) => void };
      };
    };
  };
  onMount(() => {
    const host = window as BridgeWindow;
    host.a2uiHost = {
      show(value, options) {
        const nextKey = keyFor(value);
        if (nextKey === undefined || nextKey !== payloadKey) {
          payload = value;
          payloadKey = nextKey;
        }
        locale = options?.locale === "zh" ? "zh" : "en";
        document.documentElement.lang = locale === "zh" ? "zh-Hans" : "en";
        document.documentElement.classList.toggle(
          "dark",
          options?.dark === true,
        );
        const scale = options?.fontScale;
        document.documentElement.style.fontSize = `${typeof scale === "number" && Number.isFinite(scale) ? Math.max(0.75, Math.min(2.5, scale)) * 100 : 100}%`;
        const height = options?.viewportHeight;
        modalHeight =
          typeof height === "number" && Number.isFinite(height)
            ? Math.max(200, Math.min(1200, height))
            : 480;
        if (modalOpen) reportHeight();
      },
    };
    let last = -1;
    reportHeight = () => {
      const contentHeight = container?.getBoundingClientRect().height ?? 0;
      const height = Math.ceil(
        modalOpen ? Math.max(contentHeight, modalHeight) : contentHeight,
      );
      if (height !== last && height > 0) {
        last = height;
        host.webkit?.messageHandlers?.a2uiHeight?.postMessage(height);
      }
    };
    const observer = new ResizeObserver(reportHeight);
    if (container) observer.observe(container);
    host.webkit?.messageHandlers?.a2uiReady?.postMessage("ready");
    return () => {
      observer.disconnect();
      delete host.a2uiHost;
    };
  });
</script>

<App theme="auto"
  ><View main
    ><div bind:this={container} class="a2ui-embedded">
      <Surface
        {payload}
        {locale}
        nativeMedia
        onModalChange={(open) => {
          modalOpen = open;
          reportHeight();
        }}
      />
    </div></View
  ></App
>

<style>
  .a2ui-embedded {
    width: 100%;
    min-height: 1px;
  }
</style>
