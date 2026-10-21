// `npm run init`: for now, prints what a vendor sets to run the support door, per connector,
// and exits. An interactive setup comes later; every connector's setup step lands here
// (the connector checklist in docs/connectors/README.md and test/connectors-dx.test.ts).
//
// Connectors:
//   slack: the support channel (required). See docs/connectors/slack.md.
//   resend: the reply-email notifier (optional), on the vendor's own Resend account. See docs/connectors/resend.md.

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

export interface InitStep {
  /** Connector name as in the registry (docs/connectors/README.md). */
  connector: string;
  title: string;
  required: boolean;
  vars: ReadonlyArray<{ name: string; example: string; meaning: string }>;
  doc: string;
}

export const INIT_STEPS: readonly InitStep[] = [
  {
    connector: "core",
    title: "Your support door",
    required: true,
    vars: [
      { name: "VENDOR_NAME", example: '"Acme"', meaning: "the name developers know you by" },
      { name: "PUBLIC_URL", example: "https://support.acme.dev", meaning: "this door's public https URL" },
    ],
    doc: "docs/configuration.md",
  },
  {
    connector: "slack",
    title: "Slack: the channel your support team answers in",
    required: true,
    vars: [
      { name: "SLACK_BOT_TOKEN", example: "xoxb-...", meaning: "Bot User OAuth Token, from OAuth & Permissions" },
      { name: "SLACK_APP_TOKEN", example: "xapp-...", meaning: "app-level token with connections:write, for Socket Mode" },
      { name: "SLACK_CHANNEL_ID", example: "C0123456789", meaning: "the channel the app is invited to" },
    ],
    doc: "docs/connectors/slack.md",
  },
  {
    connector: "resend",
    title: "Resend: emails a reply to the developer when their agent session has closed (your own Resend account and domain)",
    required: false,
    vars: [
      { name: "RESEND_API_KEY", example: "re_...", meaning: "a key with sending access, from resend.com/api-keys" },
      { name: "EMAIL_FROM", example: '"Acme support <support@acme.dev>"', meaning: "an address on your domain verified in Resend (SPF/DKIM)" },
    ],
    doc: "docs/connectors/resend.md",
  },
];

export const HELP = `Usage: npm run init [-- --help]

Prints the environment variables the support door needs, per connector:
${INIT_STEPS.map((s) => `  ${s.connector}${s.required ? "" : " (optional)"}: ${s.vars.map((v) => v.name).join(", ")}  (${s.doc})`).join("\n")}

Put them in .env (npm start loads it) or in your host's environment.
`;

export function initText(): string {
  const parts = INIT_STEPS.map((s) => {
    const vars = s.vars.map((v) => `${v.name}=${v.example}    # ${v.meaning}`).join("\n");
    return `# ${s.title}${s.required ? "" : " (optional)"}; see ${s.doc}\n${vars}`;
  });
  return `Add these to .env, then run npm start. The server checks them at startup and prints a fix hint for anything wrong.\n\n${parts.join("\n\n")}\n`;
}

const entry = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (entry === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  process.stdout.write(args.includes("--help") || args.includes("-h") ? HELP : initText());
}
