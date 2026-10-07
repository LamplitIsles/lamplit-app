import { expect, test } from "bun:test";
import { keetFixture } from "./keet-fixture.ts";

for (const profile of ["dm", "text-only"] as const)
  test(`Keet ${profile} fixture preserves original text and explanations without Group bytes`, async () => {
    const fixture = keetFixture(profile);
    const event = {
      action: "incoming",
      id: "owned",
      channel: "group" as const,
      senderLabel: "Alice",
      destination: "Room",
      text: "原文",
      hasImage: true,
      history: true,
    };
    const result = await fixture.control(event);
    const history = await fixture.backend.history("older-page");
    expect(history.messages[0]?.text).toBe(`原文\n\n${result.imageNote}`);
    expect(history.messages[0]?.images).toBeUndefined();
    expect(history.messages[0]?.source).toEqual({
      kind: "keet",
      channel: "group",
      senderLabel: "Alice",
      destination: "Room",
    });
    const images = [
      {
        attachmentId: "owned",
        mediaType: "image/png" as const,
        name: "owned.png",
        availability: "available" as const,
      },
    ];
    await expect(fixture.control({ ...event, images })).rejects.toThrow(
      "DM acceptance profile",
    );
    if (profile === "text-only") {
      await expect(
        fixture.control({ ...event, channel: "dm", images }),
      ).rejects.toThrow("DM acceptance profile");
      const dm = await fixture.control({
        ...event,
        channel: "dm",
        history: false,
      });
      const view = await fixture.backend.read();
      expect(view.messages[0]?.text).toContain(dm.imageNote!);
      expect(view.messages[0]?.images).toBeUndefined();
    } else {
      await fixture.control({
        ...event,
        channel: "dm",
        history: false,
        images,
      });
      expect((await fixture.backend.read()).messages[0]?.images).toEqual(
        images,
      );
    }
  });
