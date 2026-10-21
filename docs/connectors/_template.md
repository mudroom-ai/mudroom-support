# <Display name> connector

## Overview

What the platform is, which contract this connector implements (`CommunicationConnector` or `RequesterNotifier`, in `src/connectors/types.ts`), and the source file.

## Prerequisites

What the vendor and the self-hoster need before setup (accounts, plans, API access, scopes, a verified sending domain).

## Setup

Numbered steps a vendor can follow without reading the code. Name the exact menu labels. End with the env vars to set and what `npm run init` prints for this connector.

## Use cases

What an agent can do end to end through this connector (ask, wait for the reply, follow up, close, get the reply by email) and what it cannot (there is no find, quote, book, cancel or reschedule in the support door).

## Limitations

Platform rules the server cannot work around.

## Errors

Table of every `ConnectorError` code the connector throws, when, and what happens (what the agent or developer sees, what the vendor is told).

## Env vars

Table of every variable the connector reads.

## Tests

Where the tests live, how the platform is faked, and what is covered.
