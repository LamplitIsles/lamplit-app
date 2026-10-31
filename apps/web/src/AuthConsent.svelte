<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "./auth-client.ts";
  import { initialPreferences } from "./lib/companion/client/preferences.ts";

  type Details = { client: { id: string; name: string }; scopes: string[] };
  const language = initialPreferences().language;
  const text =
    language === "zh"
      ? {
          title: "确认访问权限",
          loading: "正在检查授权请求…",
          request: "以下应用请求访问你的 CFL：",
          warning: "应用名称可以被仿冒。请确认是你在要连接的应用中发起了登录。",
          access: "请求的权限",
          cfl: "访问和操作你的 CFL 数据",
          openid: "识别你的账号",
          profile: "读取账号资料",
          offline_access: "在你离线时保持访问",
          allow: "允许访问",
          deny: "拒绝",
          invalid: "授权请求无效或已过期。请返回应用重新发起登录。",
          unavailable: "无法完成请求，请检查网络后重试。",
          retry: "重试",
        }
      : {
          title: "Confirm access",
          loading: "Checking the authorization request…",
          request: "This application is requesting access to your CFL:",
          warning:
            "Application names can be copied. Continue only if you started this sign-in in the app you intended to connect.",
          access: "Requested permissions",
          cfl: "Access and operate your CFL data",
          openid: "Identify your account",
          profile: "Read your account profile",
          offline_access: "Keep access when you are offline",
          allow: "Allow access",
          deny: "Deny",
          invalid:
            "This authorization request is invalid or expired. Return to the app and sign in again.",
          unavailable:
            "Couldn't complete the request. Check your connection and try again.",
          retry: "Try again",
        };

  let details = $state<Details | null>(null);
  let loading = $state(true);
  let error = $state("");
  let busy = $state(false);
  let mounted = true;
  const invalidStatus = (status: number) => [400, 401, 403].includes(status);

  async function load() {
    loading = true;
    error = "";
    try {
      const response = await fetch("/api/auth/consent-details", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ oauth_query: window.location.search.slice(1) }),
        cache: "no-store",
      });
      if (invalidStatus(response.status)) throw new Error("invalid");
      if (!response.ok) throw new Error("unavailable");
      const value: unknown = await response.json();
      if (
        !value ||
        typeof value !== "object" ||
        !("client" in value) ||
        !value.client ||
        typeof value.client !== "object" ||
        !("name" in value.client) ||
        typeof value.client.name !== "string" ||
        !("id" in value.client) ||
        typeof value.client.id !== "string" ||
        !("scopes" in value) ||
        !Array.isArray(value.scopes) ||
        !value.scopes.every((scope: unknown) => typeof scope === "string")
      )
        throw new Error("unavailable");
      if (mounted) details = value as Details;
    } catch (cause) {
      if (mounted)
        error =
          cause instanceof Error && cause.message === "invalid"
            ? text.invalid
            : text.unavailable;
    } finally {
      if (mounted) loading = false;
    }
  }

  async function decide(accept: boolean) {
    if (busy) return;
    busy = true;
    error = "";
    try {
      const result = await auth.oauth2.consent({ accept });
      if (result.error) {
        if (invalidStatus(result.error.status)) {
          details = null;
          error = text.invalid;
          return;
        }
        throw new Error();
      }
    } catch {
      error = text.unavailable;
    } finally {
      busy = false;
    }
  }

  onMount(() => {
    document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
    void load();
    return () => {
      mounted = false;
    };
  });
</script>

<main class="consent-page">
  <section class="consent-content" aria-labelledby="consent-title">
    <div class="consent-mark" aria-hidden="true">✳</div>
    <h1 id="consent-title">{text.title}</h1>
    {#if loading}
      <p role="status">{text.loading}</p>
    {:else if details}
      <p>{text.request}</p>
      <p class="client-name">{details.client.name}</p>
      <p>{text.warning}</p>
      <h2>{text.access}</h2>
      <ul>
        {#each details.scopes as scope}
          <li>{scope in text ? text[scope as keyof typeof text] : scope}</li>
        {/each}
      </ul>
      {#if error}<p class="consent-error" role="alert">{error}</p>{/if}
      <button
        class="button button-fill consent-primary"
        disabled={busy}
        onclick={() => void decide(true)}>{text.allow}</button
      >
      <button
        class="button consent-secondary"
        disabled={busy}
        onclick={() => void decide(false)}>{text.deny}</button
      >
    {:else}
      <p class="consent-error" role="alert">{error}</p>
      {#if error === text.unavailable}<button
          class="button button-fill consent-primary"
          onclick={() => void load()}>{text.retry}</button
        >{/if}
    {/if}
  </section>
</main>

<style>
  .consent-page {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    box-sizing: border-box;
    background: var(--companion-color-canvas);
    color: var(--companion-color-text);
  }
  .consent-content {
    width: min(100%, 360px);
  }
  .consent-mark {
    color: var(--companion-color-action);
    font-size: 34px;
    margin-bottom: 18px;
  }
  h1 {
    font-size: 26px;
    line-height: 1.25;
    margin: 0 0 12px;
  }
  h2 {
    font-size: 16px;
    margin: 24px 0 8px;
  }
  p {
    color: var(--companion-color-text-muted);
    margin: 0 0 16px;
  }
  .client-name {
    color: var(--companion-color-text);
    font-weight: 600;
  }
  ul {
    padding-left: 22px;
    margin: 0 0 24px;
  }
  li {
    margin: 6px 0;
  }
  .consent-primary {
    width: 100%;
    min-height: 48px;
  }
  .consent-secondary {
    display: block;
    margin: 14px auto 0;
    min-height: 44px;
  }
  .consent-error {
    color: var(--companion-color-error);
  }
</style>
