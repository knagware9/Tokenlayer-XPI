import { describe, expect, it } from "vitest";
import { NullMailer } from "../src/mail/mailer.js";

describe("NullMailer", () => {
  it("records every send instead of transmitting it", async () => {
    const mailer = new NullMailer();
    await mailer.send("a@example.com", "Subject one", "text one", "<p>html one</p>");
    await mailer.send("b@example.com", "Subject two", "text two", "<p>html two</p>");
    expect(mailer.sent).toEqual([
      { to: "a@example.com", subject: "Subject one", text: "text one", html: "<p>html one</p>" },
      { to: "b@example.com", subject: "Subject two", text: "text two", html: "<p>html two</p>" },
    ]);
  });
});
