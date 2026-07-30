# whatsapp-connect

A Claude Code skill for wiring WhatsApp Business API into an automation — and
for getting unstuck when it refuses to send.

By **Alik Braz** — [BRAZWOOD](https://www.brazwood.com). Written from a real
end-to-end integration, including every blocker that surfaced along the way.

---

## The problem this solves

Connecting WhatsApp Business API looks like one task. It is two independent
channels behind three sequential gates, and almost every wasted day comes from
confusing them:

> **Inbound is open. Outbound is gated.**

Receiving works the moment the number is connected — no verification, no
approval, no waiting. Sending stays blocked until a chain of approvals
completes. A working inbound pipeline proves nothing about outbound.

The failure mode is predictable: you build the integration, watch messages flow
in, conclude it works, and only discover days later that nothing can leave.
Then you debug the wrong layer, because the first error code you hit is hiding
the one that actually matters.

## What the skill gives Claude

- **Diagnose from the API, never from a console.** Two read-only calls return
  the whole truth; web consoles show a partial, cached view and hide the real
  error.
- **A decision tree per error code** — `131031`, `131047`, `131026`, `132000`,
  `368` — with what each one *actually* means and which party can fix it.
- **The three gates in order**, and what to build while waiting on each.
- **How to unblock a stuck partner verification**, which has no self-serve
  button anywhere.
- **Coexistence** — keeping an existing personal number working normally in the
  phone app while it also feeds the API.
- **The 24-hour service window** and why a scheduled digest cannot be plain
  text, plus the quick-reply-button pattern that solves it.
- **Webhook rules** that prevent duplicate and dropped messages.
- **Safety rules** — no sending on the user's behalf, no submitting forms for
  them, no clicking controls by screen position.

## Install

Clone into your Claude Code skills directory:

```bash
git clone https://github.com/alikbraz/whatsapp-connect.git
cp -r whatsapp-connect/skills/whatsapp-connect ~/.claude/skills/
```

On Windows the skills directory is `%USERPROFILE%\.claude\skills`.

The skill loads automatically whenever a conversation touches WhatsApp Business
API, or on demand with `/whatsapp-connect`.

## The guide

`guide/whatsapp-guide.html` is a standalone, self-contained page walking through
all seven steps with a direct, verified link to the right screen at each one.
Hebrew, right-to-left, light and dark themes, no external dependencies — open it
in any browser.

It covers the same ground as the skill but written for a person rather than for
an agent: what to expect, what will stall, and a realistic timeline.

## Error codes at a glance

| Code | Real meaning | Who fixes it |
|---|---|---|
| `131031` | Business account locked — provider has not finished verifying you | Your provider, via support ticket |
| `131047` | 24-hour service window closed | You, with an approved template |
| `131026` | Recipient unreachable or number malformed | You, check international format |
| `132000` | Template parameter count mismatch | You, match the approved body |
| `368` | Temporarily restricted for low quality rating | You, reduce send rate |

Fixing one error routinely reveals another underneath it. `131047` masks
`131031` almost every time.

## License

MIT
