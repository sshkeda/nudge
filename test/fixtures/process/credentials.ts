process.stdout.write(process.env["FIXTURE_CREDENTIALS"] ?? "")
process.exitCode = Number(process.env["FIXTURE_EXIT_CODE"] ?? 0)
