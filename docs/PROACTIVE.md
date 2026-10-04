# Proactive mode — first release

Open **Mysti: Open Proactive Inbox** from the Command Palette, the bell in Mysti’s sidebar title, or **Proactive inbox** in the composer’s actions menu. It is independent of the selected coding provider and of OpenClaw Active Mode.

Nothing is watched until you enable a watch. Watching is read-only: it does not authorize sending messages, running tests, changing files, or publishing work.

## Local repositories

Choose **Watch a local repository**, then select a trusted workspace folder that is a Git repository root and has at least one commit. Mysti checks every minute while the extension is running.

The inbox reports incoming commits on the locally fetched upstream, incoming paths that overlap uncommitted working files, and changes to HEAD since the preceding observation. Mysti does not fetch the remote, so an unchanged local tracking ref is not evidence that the remote has not changed. Detached HEAD and repositories without an upstream still support HEAD-change observation.

Local paths, filenames, snapshots, and insights remain in VS Code’s workspace storage. Each workspace supports up to 10 watches, with up to 100 insights retained per watch. Pause stops future observations; removing a watch deletes its local snapshots and insights. Closing VS Code stops local monitoring. Reopening a trusted watched workspace resumes it.

## Connected work through DeepMyst

Sign in to DeepMyst and connect GitHub or Slack through **Manage connections**. Select one connected account, provide an exact `owner/repo` or Slack channel ID, and specify 1–8 terms of 3–80 characters each. Enabling that watch explicitly grants read monitoring of that resource. Other connected apps remain unavailable for monitoring.

DeepMyst polls approximately every five minutes. Each worker tick processes at most 10 due watches; backlogs can delay a check. Last successful checks and stale-state notices show the actual coverage. Responsibilities continue on the server when the editor is closed. Signing out of Mysti stops this client’s access; **pause or remove cloud watches before signing out to stop server monitoring**.

- GitHub: one page of up to 100 open/closed pull requests per check, newest creation first; saved page progress continues on later checks. Term matching in titles and descriptions. A newly created PR can shift pagination; this is not a snapshot or complete event history. Branches, issues, reviews, comments, and file diffs remain excluded.
- Slack: one page of up to 15 top-level messages per check in a fixed seven-day window, using saved timestamp pagination until the scan finishes. Thread replies remain excluded. Source links open the channel; the stored timestamp/excerpt identifies the observed message.
- Matches indicate relevance, not proof of duplicate work. This release uses deterministic terms, not semantic inference or an LLM.
- Insights retain an observation excerpt and source reference. Later edits can create a new insight; dismissed evidence versions stay dismissed until retention expiry. Source deletion is not yet reconciled. Review the current source before acting.
- Up to 10 cloud responsibilities per user per organization. The inbox shows the latest 100 non-dismissed insights. Evidence older than 30 days is excluded and removed by the worker, including paused responsibilities.
- Revoked connections no longer contribute visible evidence; deleted connections cascade-delete their responsibilities and insights. A lost active organization membership pauses monitoring. Embedded and agent-scoped credentials cannot use this feature.

Scans stop after 100 pages or restart after 24 hours with an explicit coverage-gap notice. A new scan starts at the next scheduled check after completion. Rate limits retain progress and delay the next attempt according to provider headers (minimum five minutes). New source activity may wait until the next scan; edits/deletions are not fully reconciled. The displayed last-check time means one page succeeded, not that the whole source is current.

## Before you start

In the Proactive inbox, select a connected responsibility, optionally enter a task summary, and choose **Check task context**. Mysti refreshes the authorized inbox and shows up to 20 related evidence items with source links, observation times, and versions. New evidence may include its source author and PR state; an author is not necessarily the current task owner.

The optional summary only ranks existing evidence on this machine. It is neither saved nor uploaded to DeepMyst or your coding provider. Paused watches, stale checks, bounded coverage, and empty evidence are explained. No matches do not mean nobody else is working on the task. Editing the summary, refreshing, or signing out clears the result. Chat is unaffected by monitoring availability.

## Notifications

Enable **Notify me in VS Code** for generic inbox summaries, without source excerpts. Delivery occurs only while the extension is running, with at most three summaries per workspace per day between 08:00 and 20:00 in the host machine’s timezone. Quiet hours do not suppress the inbox itself. This is a VS Code notification, not a background OS push service. New insights older than 24 hours are available in the inbox without a toast.

Mobile push, SMS/phone alerts, email/calendar adapters, automatic chat preflight, semantic requirement comparison, cross-source prioritization, delegated tests, and autonomous execution remain future increments from plans 39–40. This first release does not implement the entire roadmap.

## DeepMyst deployment

Backend code lives in the adjacent `DeepMyst 2.0` repository:

Production deployment on 2026-10-03 is tracked in [rollout and next steps](../plans/42-proactive-rollout-and-next-steps.md) and [continuation plan 43](../plans/43-proactive-continuation.md). The API and worker run commit `d352950df4245f636d30dfb5e03e1c18d6f758eb` through [DeepMyst PR #1014](https://github.com/DeepMyst/DeepMyst-2.0/pull/1014).

For subsequent environments:

1. Confirm database recovery coverage and apply Alembic migrations **182m** and **183m** using the normal deployment process (`python -m alembic upgrade heads` from `apps/core-api`). The prototype's local migration 147 conflicts with production history and must not be applied there. Render runs the migration as the API pre-deploy command.
2. Deploy the updated core-api and ARQ worker together. The worker includes `src.tasks.proactive.proactive_tick`; its Dockerfile already copies the core-api domains and model registry.
3. Configure **`COMPOSIO_PROXY_API_KEY`** on both services using a Composio project credential authorized for proxy execution. Prefer a dedicated credential with **`proxy_execute`** scope and separate connection/catalog credentials. The initial production rollout reuses the existing compatible server credential; dedicated credential rotation remains an operational follow-up. Docker Compose and the example environment files expose the new setting. No credential belongs in Mysti’s webview or workspace files.
4. Have a user explicitly connect an account and enable a narrowly scoped watch. Verify the last-check timestamp and source evidence before expanding usage.

If the endpoint is absent, Mysti reports that cloud monitoring is not deployed and local monitoring still works. If the proxy credential is absent, the server disables cloud creation. 401/403 responses request a suitable personal identity. Upstream failures preserve the previous successful timestamp and retry after five minutes; stale watches are flagged after 15 minutes.

The API is `/api/v1/me/proactive`: GET state; POST `/responsibilities`; PATCH/DELETE `/responsibilities/{id}`; PATCH `/insights/{id}`. State changes require the responsibility revision; stale updates are rejected. Provider requests use fixed GET endpoints and the selected connected-account ID, never arbitrary MCP commands or instruction text from a source.

Composio’s [generated proxy API contract](https://github.com/ComposioHQ/composio-base-py/blob/master/src/composio_client/resources/tools.py) documents the scoped credential requirement; [proxy request parameters](https://github.com/ComposioHQ/composio-base-py/blob/master/src/composio_client/types/tool_proxy_params.py) and [response shape](https://github.com/ComposioHQ/composio-base-py/blob/master/src/composio_client/types/tool_proxy_response.py) informed the adapters.
