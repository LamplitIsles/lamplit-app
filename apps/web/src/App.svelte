<script lang="ts">
  import { App } from "konsta/svelte";
  import { Router } from "sv-router";
  import "./router.ts";
  import AuthGate from "./AuthGate.svelte";
  import { onMount } from "svelte";
  import { get } from "svelte/store";
  import { applyUiTheme, uiTheme, watchUiTheme } from "./lib/companion/client/ui-theme.js";
  import { initialPreferences, resolveScheme } from "./lib/companion/client/preferences.ts";
  applyUiTheme(get(uiTheme));
  $effect(() => applyUiTheme($uiTheme));
  onMount(watchUiTheme);
  const preferences = initialPreferences();
  document.documentElement.classList.toggle("dark", resolveScheme(preferences.appearance, preferences.systemDark) === "dark");
  document.documentElement.lang = preferences.language === "zh" ? "zh-Hans" : "en";
</script>

<App theme={$uiTheme} class="konsta-chat">
  <AuthGate><Router /></AuthGate>
</App>
