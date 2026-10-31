<script lang="ts">
  import { onMount, type Snippet } from "svelte";
  import {
    startAuthentication,
    startRegistration,
    type PublicKeyCredentialCreationOptionsJSON,
    type PublicKeyCredentialRequestOptionsJSON,
  } from "@simplewebauthn/browser";
  import { initialPreferences } from "./lib/companion/client/preferences.ts";

  let { children }: { children: Snippet } = $props();
  let authState = $state<
    "loading" | "host" | "setup" | "signed_out" | "signed_in" | "error"
  >("loading");
  let recovery = $state(false);
  let code = $state("");
  let busy = $state(false);
  let error = $state("");
  let language = $state(initialPreferences().language);
  const text = $derived(
    language === "zh"
      ? {
          loading: "正在检查登录状态…",
          title: "欢迎回来",
          setup: "设置 Passkey",
          description: "使用 Passkey 安全登录。",
          pair: "输入在主机上生成的一次性配对码，然后创建 Passkey。",
          label: "一次性配对码",
          signIn: "使用 Passkey 登录",
          create: "创建 Passkey",
          recovering: "使用配对码恢复",
          back: "返回登录",
          retry: "重试",
          unavailable: "无法连接，请检查网络后重试。",
          invalid: "配对码无效或已过期，请在主机上生成新的配对码。",
          failed: "登录未完成，请重试。",
          unsupported:
            "此浏览器无法使用 Passkey，请使用支持 Passkey 的浏览器和安全连接。",
          pending: "请在设备上完成验证…",
        }
      : {
          loading: "Checking sign-in…",
          title: "Welcome back",
          setup: "Set up a passkey",
          description: "Sign in securely with your passkey.",
          pair: "Enter the one-time pairing code generated on your host, then create a passkey.",
          label: "One-time pairing code",
          signIn: "Sign in with a passkey",
          create: "Create passkey",
          recovering: "Recover with a pairing code",
          back: "Back to sign in",
          retry: "Try again",
          unavailable: "Can't connect. Check your connection and try again.",
          invalid:
            "The pairing code is invalid or expired. Generate a new code on your host.",
          failed: "Sign-in wasn't completed. Please try again.",
          unsupported:
            "Passkeys aren't available here. Use a supported browser and a secure connection.",
          pending: "Complete verification on your device…",
        },
  );
  $effect(() => {
    if (authState !== "host" && authState !== "signed_in") {
      language = initialPreferences().language;
      document.documentElement.lang = language === "zh" ? "zh-Hans" : "en";
    }
  });
  let mounted = true;
  let knownPasskey = false;
  let statusRequest = 0;
  async function refresh() {
    const request = ++statusRequest;
    try {
      const response = await fetch("/api/auth/status", { cache: "no-store" });
      if (!mounted || request !== statusRequest) return;
      if (response.status === 404) {
        authState = knownPasskey ? "error" : "host";
        return;
      }
      if (!response.ok) throw new Error("unavailable");
      const data = await response.json();
      if (
        data.mode !== "passkey" ||
        !["setup", "signed_out", "signed_in"].includes(data.state)
      )
        throw new Error("invalid status");
      if (mounted && request === statusRequest) {
        knownPasskey = true;
        authState = data.state;
      }
    } catch {
      if (mounted && request === statusRequest) authState = "error";
    }
  }
  async function post(path: string, body: unknown) {
    const response = await fetch(`/api/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data?.error?.code || "unavailable");
    return data;
  }
  async function authenticate(register: boolean) {
    if (busy) return;
    if (!window.isSecureContext || !window.PublicKeyCredential) {
      error = text.unsupported;
      return;
    }
    busy = true;
    error = "";
    try {
      const method = register ? "register" : "login";
      const { options, ceremony } = await post(
        `${method}/options`,
        register ? { code: code.trim() } : {},
      );
      const response = register
        ? await startRegistration({
            optionsJSON: options as PublicKeyCredentialCreationOptionsJSON,
          })
        : await startAuthentication({
            optionsJSON: options as PublicKeyCredentialRequestOptionsJSON,
          });
      await post(`${method}/verify`, { ceremony, response });
      code = "";
      recovery = false;
      await refresh();
    } catch (cause) {
      error =
        cause instanceof Error && cause.message === "invalid_pairing"
          ? text.invalid
          : cause instanceof TypeError ||
              (cause instanceof Error && cause.message === "unavailable")
            ? text.unavailable
            : text.failed;
    } finally {
      busy = false;
    }
  }
  onMount(() => {
    mounted = true;
    void refresh();
    const timer = window.setInterval(() => {
      if (authState === "signed_in" && !document.hidden) void refresh();
    }, 15000);
    const visible = () => {
      if (authState === "signed_in" && !document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", visible);
    return () => {
      mounted = false;
      clearInterval(timer);
      document.removeEventListener("visibilitychange", visible);
    };
  });
</script>

{#if authState === "host" || authState === "signed_in"}
  {@render children()}
{:else}
  <main class="auth-page">
    <section class="auth-content" aria-labelledby="auth-title">
      <div class="auth-mark" aria-hidden="true">✳</div>
      {#if authState === "loading"}
        <p role="status">{text.loading}</p>
      {:else if authState === "error"}
        <h1 id="auth-title">Lamplit</h1>
        <p role="alert">{text.unavailable}</p>
        <button
          class="button button-fill auth-primary"
          onclick={() => {
            authState = "loading";
            void refresh();
          }}>{text.retry}</button
        >
      {:else}
        {@const registering = authState === "setup" || recovery}
        <h1 id="auth-title">{registering ? text.setup : text.title}</h1>
        <p>{registering ? text.pair : text.description}</p>
        {#if registering}
          <form
            onsubmit={(event) => {
              event.preventDefault();
              void authenticate(true);
            }}
          >
            <label for="pairing-code">{text.label}</label>
            <input
              id="pairing-code"
              type="text"
              bind:value={code}
              autocomplete="off"
              autocapitalize="off"
              spellcheck="false"
              required
              disabled={busy}
            />
            <button
              class="button button-fill auth-primary"
              type="submit"
              disabled={busy || !code.trim()}>{text.create}</button
            >
          </form>
        {:else}
          <button
            class="button button-fill auth-primary"
            disabled={busy}
            onclick={() => void authenticate(false)}>{text.signIn}</button
          >
        {/if}
        {#if busy}<p role="status">{text.pending}</p>{/if}
        {#if error}<p class="auth-error" role="alert">{error}</p>{/if}
        {#if authState !== "setup"}<button
            class="button auth-secondary"
            disabled={busy}
            onclick={() => {
              recovery = !recovery;
              error = "";
              code = "";
            }}>{recovery ? text.back : text.recovering}</button
          >{/if}
      {/if}
    </section>
  </main>
{/if}

<style>
  .auth-page {
    min-height: 100%;
    display: grid;
    place-items: center;
    padding: 24px;
    box-sizing: border-box;
    background: var(--companion-color-canvas);
    color: var(--companion-color-text);
  }
  .auth-content {
    width: min(100%, 360px);
  }
  .auth-mark {
    color: var(--companion-color-action);
    font-size: 34px;
    margin-bottom: 18px;
  }
  h1 {
    font-size: 26px;
    line-height: 1.25;
    margin: 0 0 12px;
  }
  p {
    color: var(--companion-color-text-muted);
    margin: 0 0 24px;
  }
  label {
    display: block;
    font-weight: 600;
    margin-bottom: 8px;
  }
  input {
    display: block;
    width: 100%;
    box-sizing: border-box;
    padding: 12px;
    border: 1px solid var(--companion-color-outline);
    border-radius: 10px;
    background: var(--companion-color-surface);
    color: var(--companion-color-text);
    font: inherit;
    margin-bottom: 20px;
  }
  .auth-primary {
    width: 100%;
    min-height: 48px;
  }
  .auth-secondary {
    margin: 14px auto 0;
    min-height: 44px;
  }
  .auth-error {
    color: var(--companion-color-error);
    margin-top: 16px;
  }
  [role="status"] {
    margin-top: 16px;
  }
</style>
