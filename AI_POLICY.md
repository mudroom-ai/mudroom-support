# AI policy

AI-generated contributions that nobody checked cost a lone maintainer real time to read, test and reject. We use AI tools ourselves and are happy for you to use them too. This policy is about accountability, not tooling.

## You own what you submit

Understand every line you send. You should be able to explain the change and defend it in review without going back to a prompt.

## Prove it works

Run the code. For connector changes, add tests against a scripted fake of the platform (see [CONTRIBUTING.md](CONTRIBUTING.md)), and say in the PR what you verified and what you did not. Do not claim manual testing you did not do.

## Disclose AI use

If an agent wrote or co-wrote the PR, fill in the "Agent context" section of the PR template: tool, model and how much it did on its own.

## Prefer PRs over AI-generated issues

If you found a bug, a fix with a test is worth more than a long report. Bug reports and security reports that are AI-written and unreviewed by you are closed without reply.

## No unsolicited AI reviews

Do not post AI-generated review comments on other people's PRs.

## What happens

The first time, we close the PR or issue with a link to this policy. After a second closure, the account is blocked.

This is not an anti-AI policy. Used with care, it is a good way to contribute. Used as a firehose, it is spam.
