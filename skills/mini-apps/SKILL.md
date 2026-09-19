---
name: mini-apps
description: >-
  Build, deploy and iterate on a personal "mini app": a small, single-purpose, mobile-first
  app the user actually uses daily, hosted cheaply in their own Google Cloud project and
  shared by link. Use when the user asks to build, create, scaffold or deploy a "mini app",
  a personal app, a private/household app, a PWA for their phone, an AI-powered tool just
  for them (or their partner/friends), or says "use the mini-apps skill".
---

# Mini apps

A mini app is personal software: one job, done exactly the user's way, used every day, living
on their phone's home screen, and cheap enough to ignore on the bill. It is not a product for
strangers — it's built for one person or a small circle, deployed for real (not just a local
demo), and shared with a link.

This is a playbook, not a spec. It gives you a menu of building blocks and a process, not a
required stack, file layout or command sequence. Make your own low-level choices — including
skipping any block here entirely — based on what the app actually needs.

## Intake (keep it short)

Before building, get a feel for:

- The purpose and the core loop — the one thing the user will do every day.
- Who uses it — just them, a household, a few invited friends, or anyone.
- What data it needs to remember, and what it should learn about the user over time.
- What the AI should actually do — generate things, answer questions, chat and take action, or
  just assist.
- Which Google Cloud project to deploy into.
- Which LLM provider to use and where any key lives.

Ask about these in one go if you need to, but don't interrogate the user. Where an answer is
obvious or low-stakes, pick a sensible default, state it, and keep moving — a mini app is meant
to come together in an evening, not a requirements meeting.

## A menu of building blocks

These are options, not a checklist — use what the app genuinely needs and skip the rest.

- **PWA front end**: an installable web app that lives on the phone's home screen and opens
  full-screen. Usually React + Vite + Tailwind, but any front end that builds to static files
  works. Use it when the user wants something that feels like a native app.
- **A small API server**: Node/Express is the well-worn choice, but anything comparable is
  fine. Use it whenever the app needs to hold state, talk to an LLM, or keep secrets off the
  client.
- **Hosting**: Google Cloud App Engine Standard is simple and scales to zero when idle, a good
  default for a low-traffic personal app. Cloud Run is a better fit for containerized workloads,
  longer-running requests, or anything App Engine Standard doesn't comfortably support.
- **Data storage**: Firestore is a convenient default in a Google Cloud project — no server to
  manage, generous free tier. Use Cloud SQL or another store instead when the data is genuinely
  relational or otherwise a poor fit for a document store.
- **Auth, matched to who's using it**: a shared access code plus a magic link for the user or
  their household; per-person invite tokens for a handful of friends; Firebase Authentication
  once strangers can sign themselves up. Start with the simplest tier that fits today's audience.
- **LLM access**: Vertex AI Gemini needs no separate API key and bills through the same Google
  Cloud project — a convenient default. An external provider such as OpenAI is just as valid,
  especially if the user already has a key or a model preference.
- **Scheduled work**: Cloud Scheduler triggering a Cloud Function is the standard serverless
  pattern; a Claude Code routine that calls the app's own API on a schedule is a lighter-weight
  alternative if the user already has a Claude subscription.
- **Secrets**: keep them in a gitignored config file or in Secret Manager — never in code, never
  printed, never committed.

## AI patterns worth reusing

A few conceptual patterns show up repeatedly in apps like this, independent of stack:

- **Structured output** for anything the app generates and stores — ask the model for JSON
  against a schema, and validate it again in code before trusting it.
- **A free-text "preferences" document** that both the app and the user can edit — a running,
  human-readable memory of taste and context, not a rigid settings object.
- **An autonomous, tool-using chat agent** that can actually change the app's data (add an item,
  update a plan, log an entry) and reports back what it did, rather than just answering questions.
- **Lightweight feedback loops** — thumbs up/down or similar — that periodically feed back into
  the preferences document, so the app's sense of what the user likes keeps improving.

## Design for more than one user, even with one user

Even when only one person will ever use the app, scope the data model per user from day one
(every record tied to a user id, even if there's only one). Retrofitting that later usually
means a data migration; doing it up front costs almost nothing.

## The build process

1. Agree a short spec with the user first — purpose, core loop, data, AI behavior, auth tier.
   It doesn't need to be formal, but it should be concrete enough that two people (or two
   subagents) building against it independently would build compatible things.
2. Put the app in its own git repo, private by default unless the user says otherwise.
3. Build in parallel where it helps: subagents for backend, frontend, and
   integration-plus-deploy can all work from the same spec at once. This is a convenience, not
   a requirement — a small app may not need splitting up at all.
4. Deploy early, then actually use the live app — click through the real thing rather than
   trusting a local build.
5. Write down what you learned as you went (a CLAUDE.md or similar) — gotchas, dead ends,
   things you'd tell your next self before touching this app again.
6. Iterate in small rounds with the user: they react to the live app, you adjust, redeploy,
   confirm.

## Warnings worth knowing

- On App Engine, the first service in a project must be named `default`; anything after that is
  a named service.
- If the app uses Firestore, its region and the hosting region must match — check the existing
  Firestore location before picking a region for anything new.
- Any client build step (bundling, compiling) needs to actually run as part of the deployment
  build, not just locally — a deploy that skips it ships stale or broken assets.
- Don't let the HTML entry point get cached — a returning user can otherwise get stuck on a
  stale version of the app after a redeploy.
- If the Google Cloud project already hosts other services or apps, never touch, stop or
  redeploy them by accident — check what else is there before you start.
- Never print, log or commit secrets, and double-check `git status` before every commit.
- Keep costs near zero: scale-to-zero hosting, and a small budget alert on the project so a bug
  can't run up a real bill unnoticed.
- A long autonomous build session needs the machine to stay awake for it, or it'll stall
  partway through.

See [reference/gotchas.md](reference/gotchas.md) for more concrete traps hit while deploying
real mini apps — worth a skim, not required reading.

## Cost

Run this way, a personal mini app should cost roughly nothing to a few euros a month — mostly
whatever the LLM calls cost, with hosting and storage inside the free tier for this kind of
traffic.

## Working references

[github.com/ThomasVrancken/meals](https://github.com/ThomasVrancken/meals) and
[github.com/ThomasVrancken/thoughtstream](https://github.com/ThomasVrancken/thoughtstream) are
two real mini apps built this way. They're worth reading if you want to see one way this all
comes together end to end — not a required pattern to copy.
