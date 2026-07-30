---
name: whatsapp-connect
description: Use when connecting, debugging, or explaining a WhatsApp Business API integration — a number that will not send, an outbound error code (131031, 131047, 131026, 132000, 368), a webhook that misses or duplicates inbound messages, business/partner verification that is stuck "pending", coexistence with an existing personal number, message templates and the 24-hour service window, or choosing/switching provider. Triggers on "וואטסאפ לא שולח", "חיבור לווצאפ", "החשבון נעול", "WABA", "webhook", "131031", "אימות עסק", "template", "BSP", or any request to wire WhatsApp into an automation.
---

# whatsapp-connect

By **Alik Braz** — BRAZWOOD. Written from a real end-to-end integration,
including every blocker that surfaced along the way.

Connecting WhatsApp Business API is not one task. It is **two independent
channels** behind **three sequential gates**, and almost every wasted day comes
from confusing them.

## The one thing to internalize

**Inbound is open. Outbound is gated.**

Receiving works the moment the number is connected — no verification, no
approval, no waiting. Sending is blocked until a chain of approvals completes.

A working inbound pipeline proves nothing about outbound. Never report
"the integration works" on the strength of received messages alone.

## Diagnose before touching anything

Never diagnose from a web console. Consoles show a partial, cached view and hide
the actual error. Ask the API directly. Two read-only calls give the whole
picture:

1. **List phone numbers** → per-number `status`, `codeVerificationStatus`,
   `qualityRating`, `messagingLimit`.
2. **List recent outbound messages** → `errorCode` + `errorMessage` per message.

Provider-specific endpoints differ; the shape does not. Load credentials from
the project's env file, never from a pasted string.

If the message list shows `failed` with no visible error, fetch a **single**
message record in full — list views often omit the error object.

## The error code decision tree

| Code | Real meaning | Correct action |
|---|---|---|
| `131031` | Business account locked — the provider has not finished verifying the business | Support ticket **with the provider**. Not an appeal to Meta. No code change will fix it. |
| `131047` | 24-hour service window closed | Approved template, or the recipient messages first |
| `131026` | Recipient not on WhatsApp, or malformed number | Full international format, leading `+` |
| `132000` | Template parameter count mismatch | Compare against the approved template body |
| `368` | Temporarily restricted for low quality rating | Reduce send rate, wait for rating recovery |

**Fixing one error often reveals another underneath it.** `131047` masks
`131031` routinely. After any fix, re-send and re-read the code — do not assume
the channel is now open.

## The three gates, in order

1. **Business details complete** — legal name, address, phone, website.
   Fill everything *before* submitting for verification: submission locks the
   form for the duration of the review, and a skipped field cannot be added.
2. **Business verification** — documents reviewed by Meta. Days to two weeks.
   Name on the document must match the portfolio character for character.
3. **Partner verification** — the provider verifies the business. Only starts
   after gate 2. This is where most integrations sit blocked, and there is no
   self-serve button.

While gates 2 and 3 run, build the entire inbound side. It works immediately.

## Unblocking a stuck partner verification

In order:

1. Fill the provider console's company record completely — legal name (exact
   match), tax/registration number, official website, industry. A missing field
   is a free reason to defer the review.
2. Open a support ticket **and** send the same text by email. Include: company
   id, WABA id, phone number, current status, the exact error code and message,
   and the verification submission date. Offer the registration certificate.
3. If nothing moves in two days, the cheapest paid tier usually unlocks live
   chat, which moves queues that email does not.

Free-tier accounts sit in a separate, slower queue at most providers. If support
latency is a recurring problem, that is a legitimate reason to migrate provider
later — but never migrate mid-review.

## Coexistence

Coexistence keeps an existing number working normally in the phone app while
also registering it for the API. Every incoming message is mirrored to the
webhook; the owner keeps chatting by hand; customers see no change and learn no
new number.

Confirm the provider supports coexistence **before** committing to it. Support
varies and it cannot be retrofitted cleanly.

## The 24-hour window — permanent, not a startup problem

Free-form text may only be sent within 24 hours of the recipient's last message.
This never goes away.

Consequences for any scheduled notification:

- A daily digest cannot be plain text. It needs an approved template.
- **Template parameters cannot contain newlines**, tabs, or 4+ consecutive
  spaces — a multi-line report will not fit inside a parameter.
- The durable pattern: a short template carrying a **quick-reply button**. The
  tap counts as a customer reply, opens the window, and the full free-form
  content follows immediately.

## Webhook rules

Three requirements, in this order:

1. **Verify the signature first**, before parsing or acting on the body. The
   endpoint is public; anyone can post to it.
2. **Respond 200 immediately**, before processing. Providers retry on slow
   responses, producing duplicate messages.
3. **Process in the background** — transcription, classification, storage.

For a home-hosted server a tunnel is sufficient. On networks that block modern
transports, forcing `http2` fixes random connection drops.

## Reporting rules

- A price, status, or capability is real only if it came from an API response or
  the user stated it. Console screenshots and assumptions are estimates — label
  them.
- Quote error codes and messages verbatim.
- When outbound is blocked, say so plainly and name which gate. Do not describe
  the integration as working.
- Propose an independent channel (Telegram, email) whenever the user needs
  notifications before the gates clear. It removes a third-party dependency
  entirely and takes about an hour.

## Safety

- Never send a message on the user's behalf without explicit approval, including
  test messages — every send is outward-facing and metered.
- Never submit a support ticket, appeal, or verification form for the user.
  Draft the text; the user sends it.
- Editing business or provider account settings requires explicit approval each
  time. Identify the control by reference, not by screen position — destructive
  buttons sit next to edit buttons.
- Never type credentials into a form or read secrets back through the shell.
