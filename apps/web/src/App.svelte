<script lang="ts">
  import { App, View } from "framework7-svelte";
  import Partner from "./Partner.svelte";
  const colors = {
    primary: getComputedStyle(document.documentElement)
      .getPropertyValue("--companion-color-accent")
      .trim(),
  };
</script>

<App
  name="Lamplit"
  id="org.lamplit.app"
  {colors}
  theme="auto"
  darkMode="auto"
  touch={{ tapHold: true, tapHoldDelay: 450, tapHoldPreventClicks: true }}
>
  <View
    main
    url="/"
    browserHistory
    browserHistorySeparator="#!"
    browserHistoryStoreHistory={false}
    browserHistoryOnLoad={false}
    iosSwipeBack={false}
    mdSwipeBack={false}
  >
    <Partner />
  </View>
</App>
