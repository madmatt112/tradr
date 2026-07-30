# Tradr terminology

One meaning per term, one term per meaning. This is the declared vocabulary the
documentation uses; [`STYLE.md`](STYLE.md) explains the rules around it.

Terminology drift is the cheapest documentation defect to prevent and the most
expensive to fix later, because every page has to change at once. Pick the
approved term below and use only that one.

## Product and deployment

| Use | Not | Why |
| --- | --- | --- |
| **instance** | deployment, stack, install, box | One running copy of Tradr. "Stack" means the three containers specifically; an instance is the thing an operator owns. |
| **the stack** | the containers, the compose stack | The three services (`web`, `api`, `postgres`) started by one compose file. |
| **self-hosted** | on-prem, on-premise, local install | Tradr run by the reader on their own infrastructure. |
| **hosted** | cloud, SaaS, managed platform | `app.tradr.cloud`, run by us. |
| **operator** | admin, sysadmin, self-hoster | The person who runs an instance. May or may not be the person trading on it. |
| **contributor** | developer, dev | Someone changing the code. |

## Trading domain

| Use | Not | Why |
| --- | --- | --- |
| **position** | trade | A position is the record Tradr stores: one symbol, one direction, its whole lifecycle. Do not use "trade" for it. |
| **trade** | — | Only in the general sense of the activity ("your trading", "before you take the trade"). Never as a synonym for a stored position. |
| **fill** | execution, transaction | One buy or sell that moves a position. A position has one or more fills. |
| **account** | brokerage account, broker account | A brokerage account inside Tradr, with a currency and a balance. Always qualify on first use per page: "a brokerage account (an **account** in Tradr)". |
| **advisor** | AI, the AI, assistant, chatbot | The conversational feature. "AI advisor" is allowed once, for introduction; thereafter "the advisor". |
| **BYOK** | bring-your-own-key, own key | Spell it out on first use per page, then abbreviate. |
| **equity curve** | balance chart, P&L chart | The account-value-over-time chart. |
| **realized P&L** | profit, gains, returns | Money from closed positions. Always write "P&L", never "PnL" or "P/L". |

## Configuration

| Use | Not | Why |
| --- | --- | --- |
| **environment variable** | env var, setting, config value | Spell it out in prose. `env var` is acceptable in a table header where space is tight. |
| **required** | mandatory, must-have | Reserved for the three values with no working default. |
| **optional** | not required | Everything else. An optional integration is **absent when unconfigured, not broken** — say it that way. |
| **feature gating** | paywall, plan limits, tiers | The `FEATURE_GATING` mechanism. Off by default; self-hosted instances have no tiers at all. |

## Words to avoid entirely

| Avoid | Instead |
| --- | --- |
| simply, just, easily, obviously | Delete. If a step is easy, the reader will notice; if it isn't, you have lied. |
| should work, ought to | State what happens, or test it and then state it. |
| leverage, utilise | use |
| in order to | to |
| please (in instructions) | Delete. "Please run" → "Run". |
