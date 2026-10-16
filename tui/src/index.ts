#!/usr/bin/env bun
import { main } from "./app"

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
