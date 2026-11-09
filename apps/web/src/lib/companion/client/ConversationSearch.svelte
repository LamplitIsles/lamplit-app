<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import {
    overlayOpening,
    overlayOpened,
    overlayClosed,
    overlayDestroyed,
  } from "./overlay-focus.ts";
  import {
    Block,
    BlockFooter,
    BlockTitle,
    Button,
    List,
    ListItem,
    Message,
    Messages,
    Preloader,
    Popup,
    Searchbar,
  } from "konsta/svelte";
  import ArrowLeft from "lucide-svelte/icons/arrow-left";
  import X from "lucide-svelte/icons/x";
  import type { CompanionTranslate } from "./locale.js";
  import {
    contextTargetIndex,
    textParts,
  } from "./conversation-search-highlight.js";

  import type {
    SearchCard as Card,
    SearchReadResult as Expanded,
  } from "@lamplit/contracts";
  import type { CompanionActions } from "./companion-bridge.ts";
  export let actions: CompanionActions;

  export let t: CompanionTranslate;
  export let locale: string;
  export let companionName: string;
  export let onClose: () => void;

  let dialog: HTMLElement;
  let reader: HTMLDivElement;
  let query = "";
  let searched = "";
  let results: Card[] = [];
  let estimatedTotal: number | null = null;
  let limited = false;
  let searchedOnce = false;
  let searching = false;
  let searchError = false;
  let selected: Card | undefined;
  let expanded: Expanded | undefined;
  let reading = false;
  let readError = false;
  let searchRequest: AbortController | undefined;
  let readRequest: AbortController | undefined;

  onDestroy(() => {
    searchRequest?.abort();
    readRequest?.abort();
    if (dialog) overlayDestroyed({ el: dialog });
  });

  function close() {
    overlayClosed({ el: dialog });
    onClose();
  }
  onMount(() => {
    overlayOpening({ el: dialog });
    overlayOpened({ el: dialog });
  });
  function configureSearchForm(node: HTMLFormElement) {
    let mounted = true;
    void tick().then(() => {
      if (!mounted) return;
      const input = node.querySelector<HTMLInputElement>("input");
      if (input) {
        input.type = "search";
        input.enterKeyHint = "search";
        input.maxLength = 500;
        input.autocomplete = "off";
        input.setAttribute("aria-label", t("search.open"));
      }
    });
    return { destroy() { mounted = false; } };
  }
  function keydown(event: KeyboardEvent) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); }
  }
  function date(value?: string): string {
    if (!value || Number.isNaN(Date.parse(value))) return "";
    return new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(value));
  }
  function sender(item: { kind: string; role?: string }): string {
    if (item.kind === "compaction") return t("search.summary");
    return item.role === "user" ? t("you") : companionName;
  }
  async function search(event?: SubmitEvent) {
    event?.preventDefault();
    const value = query.trim();
    if (!value) return;
    searchRequest?.abort();
    const request = new AbortController();
    searchRequest = request;
    readRequest?.abort();
    readRequest = undefined;
    searched = value;
    searchedOnce = true;
    searching = true;
    searchError = false;
    results = [];
    selected = undefined;
    expanded = undefined;
    try {
      if (!actions.search) throw new Error("Search unavailable");
      const data = await actions.search({ query: value });
      if (searchRequest !== request) return;
      results = data.hits;
      estimatedTotal = data.estimatedTotalHits;
      limited = data.limited;
    } catch (error) {
      if (searchRequest === request && (error as Error).name !== "AbortError")
        searchError = true;
    } finally {
      if (searchRequest === request) searching = false;
    }
  }
  async function openRecord(card: Card) {
    readRequest?.abort();
    const request = new AbortController();
    readRequest = request;
    selected = card;
    expanded = undefined;
    reading = true;
    readError = false;
    try {
      if (!actions.searchRead) throw new Error("Record unavailable");
      const data = await actions.searchRead({ id: card.id });
      if (readRequest === request && !request.signal.aborted) expanded = data;
    } catch (error) {
      if (readRequest === request && (error as Error).name !== "AbortError")
        readError = true;
    } finally {
      if (readRequest === request) reading = false;
    }
    if (readRequest !== request || request.signal.aborted || !expanded) return;
    await tick();
    reader = dialog.querySelector<HTMLDivElement>(".companion-search-reader")!;
    if (readRequest !== request || selected?.id !== card.id) return;
    const target = reader?.querySelector<HTMLElement>(".search-target");
    if (!target) return;
    const targetIndex = contextTargetIndex(
      expanded.context.targetSourceRecordIndex,
      expanded.context.items,
    );
    if (targetIndex <= 0) {
      reader.scrollTop = 0;
      return;
    }
    if (targetIndex === expanded.context.items.length - 1) {
      reader.scrollTop = reader.scrollHeight;
      return;
    }
    const focus = target.querySelector<HTMLElement>("mark") ?? target;
    const readerRect = reader.getBoundingClientRect();
    const focusRect = focus.getBoundingClientRect();
    reader.scrollTop +=
      focusRect.top -
      readerRect.top -
      (reader.clientHeight - focusRect.height) / 2;
  }
  function backToResults() {
    readRequest?.abort();
    readRequest = undefined;
    selected = undefined;
    expanded = undefined;
  }
</script>

<svelte:window onkeydown={keydown} />
<Popup opened onBackdropClick={close}>
  <div bind:this={dialog} class="companion-search-dialog konsta-chat h-full"
  role="dialog"
  aria-modal="true"
  aria-label={t("search.title")}
>
  <div class="companion-search-page h-full flex flex-col">
    <header class="companion-search-header">
        <Button
          type="button"
          tonal
          rounded
          class="companion-search-back"
          aria-label={selected ? t("search.back") : t("close")}
          onClick={selected ? backToResults : close}
        >
          {#if selected}<ArrowLeft size={20} aria-hidden="true" />{:else}<X
              size={20}
              aria-hidden="true"
            />{/if}
        </Button>
      <h2>{t("search.title")}</h2>
      {#if !selected}
        <form class="flex items-center" use:configureSearchForm onsubmit={search}>
          <Searchbar
            class="companion-search-form"
            disableButton={false}
            value={query}
            placeholder={t("search.placeholder")}
            onInput={(event: Event) =>
              (query = (event.target as HTMLInputElement).value)}
            onChange={(event: Event) =>
              (query = (event.target as HTMLInputElement).value)}
            onFocus={(event: FocusEvent) => {
              const input = event.target as HTMLInputElement;
              input.maxLength = 500;
              input.autocomplete = "off";
              input.setAttribute("aria-label", t("search.open"));
            }}
            onClear={() => (query = "")}
          />
          <Button
            type="submit"
            class="companion-search-submit"
            disabled={!query.trim()}>{t("search.submit")}</Button
          >
        </form>
      {/if}
    </header>

    {#if selected}
      <div
        class="companion-search-reader"
        role="region"
        aria-label={t("search.reader")}
      >
        {#if reading}
          <Block class="companion-search-state" role="status"
            ><Preloader class="w-6 h-6" /><span>{t("loading")}</span></Block
          >
        {:else if readError}
          <Block class="text-align-center" role="alert"
            ><p>{t("search.readFailed")}</p>
            <Button
              type="button"
              tonal
              onClick={() => void openRecord(selected!)}>{t("retry")}</Button
            ></Block
          >
        {:else if expanded}
          {@const record = expanded.record}
          {@const targetIndex = contextTargetIndex(
            expanded.context.targetSourceRecordIndex,
            expanded.context.items,
          )}
          <Messages>
            <div class="messages-title">{date(expanded.record.createdAt)}</div>
            {#if targetIndex < 0}
              <Message
                type={expanded.record.role === "user" ? "sent" : "received"}
                name={sender(expanded.record)}
                class="companion-search-message search-target"
              >
                {#snippet text()}
                  <span class="companion-search-bubble"
                    >{#each textParts(record.content, searched) as part}{#if part.matched}<mark
                          >{part.text}</mark
                        >{:else}{part.text}{/if}{/each}</span
                  >
                {/snippet}
              </Message>
            {/if}
            {#each expanded.context.items as item, index (item.sourceRecordIndex)}
              {@const active = index === targetIndex}
              <Message
                type={item.role === "user" ? "sent" : "received"}
                name={sender(item)}
                class={active
                  ? "companion-search-message search-target"
                  : "companion-search-message"}
              >
                {#snippet text()}
                  <span class="companion-search-bubble"
                    >{#each textParts(active ? record.content : item.content, active ? searched : "") as part}{#if part.matched}<mark
                          >{part.text}</mark
                        >{:else}{part.text}{/if}{/each}</span
                  >
                {/snippet}
              </Message>
            {/each}
          </Messages>
          {#if expanded.context.truncated}<BlockFooter
              >{t("search.contextTruncated")}</BlockFooter
            >{/if}
        {/if}
      </div>
    {:else}
      <div
        class="companion-search-results"
        role="region"
        aria-label={t("search.results")}
      >
        {#if searching}
          <Block class="companion-search-state" role="status"
            ><Preloader class="w-6 h-6" /><span>{t("search.searching")}</span></Block
          >
        {:else if searchError}
          <Block class="text-align-center" role="alert"
            ><p>{t("search.failed")}</p>
            <Button type="button" tonal onClick={() => void search()}
              >{t("retry")}</Button
            ></Block
          >
        {:else if !searchedOnce}
          <Block class="text-align-center"><p>{t("search.prompt")}</p></Block>
        {:else if results.length === 0}
          <Block class="text-align-center"><p>{t("search.empty")}</p></Block>
        {:else}
          <BlockTitle aria-live="polite"
            >{t("search.count", {
              count: estimatedTotal ?? results.length,
            })}{#if limited || (estimatedTotal !== null && estimatedTotal > results.length)}
              · {t("search.limit")}{/if}</BlockTitle
          >
          <List strong inset dividers class="companion-search-list">
            {#each results as card (card.id)}
              <ListItem
                link
                linkComponent="button"
                linkProps={{ type: "button" }}
                title={sender(card)}
                subtitle={date(card.createdAt)}
                class="companion-search-result"
                onClick={() => void openRecord(card)}
              >
                {#snippet text()}
                  <span class="companion-search-snippet">{#each card.snippet.segments as part}{#if part.highlighted}<mark
                        >{part.text}</mark
                      >{:else}{part.text}{/if}{/each}</span>
                {/snippet}
              </ListItem>
            {/each}
          </List>
        {/if}
      </div>
    {/if}
  </div></div>
</Popup>
