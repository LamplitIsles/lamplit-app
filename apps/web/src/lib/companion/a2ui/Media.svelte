<script lang="ts">
  import { Button } from "framework7-svelte";
  import { getContext } from "svelte";
  import Play from "lucide-svelte/icons/play";
  import Pause from "lucide-svelte/icons/pause";
  import type { A2uiComponentProps } from "svelte-a2ui";
  let {
    a2ui,
    url = "",
    posterUrl,
    description = "",
    ariaLabel,
    variant = "mediumFeature",
    fit = "fill",
  }: A2uiComponentProps = $props();
  const sizes: Record<string, string> = {
    icon: "24px",
    avatar: "40px",
    smallFeature: "100px",
    mediumFeature: "200px",
    largeFeature: "400px",
    header: "100%",
  };
  const size = $derived(sizes[String(variant)] ?? "200px");
  const locale = getContext<() => string>("a2ui-locale") ?? (() => "en");
  let video = $state<HTMLVideoElement>();
  let audio = $state<HTMLAudioElement>();
  const player = $derived(video ?? audio);
  let playing = $state(false);
  let failed = $state(false);
  async function toggle() {
    if (!player) return;
    if (!player.paused) {
      player.pause();
      return;
    }
    try {
      await player.play();
    } catch {
      failed = true;
    }
  }
</script>

{#if a2ui.component === "Image"}
  <img
    class="a2ui-media-image"
    class:avatar={variant === "avatar"}
    style:width={size}
    style:height={variant === "header" ? "auto" : size}
    style:object-fit={fit === "scaleDown" ? "scale-down" : String(fit)}
    src={String(url)}
    alt={String(description || ariaLabel || "")}
    crossorigin="anonymous"
    referrerpolicy="no-referrer"
    onerror={() => (failed = true)}
  />
{:else}
  <div
    class="a2ui-media"
    role="group"
    aria-label={String(
      ariaLabel ||
        description ||
        (a2ui.component === "Video" ? "Video" : "Audio"),
    )}
  >
    {#if a2ui.component === "Video"}
      <!-- svelte-ignore a11y_media_has_caption: captions are supplied by the source when available -->
      <video
        bind:this={video}
        src={String(url)}
        poster={posterUrl ? String(posterUrl) : undefined}
        crossorigin="anonymous"
        playsinline
        preload="metadata"
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
        onended={() => (playing = false)}
        onerror={() => (failed = true)}
      ></video>
    {:else}
      <audio
        bind:this={audio}
        src={String(url)}
        crossorigin="anonymous"
        preload="metadata"
        onplay={() => (playing = true)}
        onpause={() => (playing = false)}
        onended={() => (playing = false)}
        onerror={() => (failed = true)}
      ></audio>
    {/if}
    <Button
      type="button"
      tonal
      round
      onClick={toggle}
      aria-label={playing
        ? locale() === "zh"
          ? "暂停"
          : "Pause"
        : locale() === "zh"
          ? "播放"
          : "Play"}
      disabled={failed}
      >{#if playing}<Pause size={18} />{:else}<Play size={18} />{/if}</Button
    >
    {#if description}<span>{String(description)}</span>{/if}
  </div>
{/if}
{#if failed}<span class="a2ui-media-error" role="status"
    >{locale() === "zh" ? "媒体无法加载" : "Unable to load media"}</span
  >{/if}

<style>
  .a2ui-media,
  .a2ui-media-image {
    margin: 0.4rem;
    max-width: calc(100% - 0.8rem);
    border-radius: 10px;
  }
  .a2ui-media-image {
    display: block;
    max-height: 240px;
    object-fit: contain;
  }
  .a2ui-media-image.avatar {
    border-radius: 50%;
  }
  .a2ui-media {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  video {
    display: block;
    width: 100%;
    max-height: 240px;
    background: #111;
    border-radius: 10px;
  }
  .a2ui-media-error {
    font-size: 0.8rem;
    opacity: 0.7;
  }
</style>
