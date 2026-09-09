# Contributing

Create a branch for each focused change and keep generated or machine-local
files outside the repository. Before opening a pull request, run:

```bash
python3 scripts/check-public.py
python3 tests/install_test.py
node tests/command_judge_test.mjs
bash -n install.sh update.sh make-bundle.sh serve.sh
```

Changes to an extension should include a regression test when the behavior can
be checked without a real model server. Changes to installation behavior should
extend `tests/install_test.py`.

Do not commit endpoint addresses, port assignments, API keys, runtime
`models.json`, activity or permission logs, conversation transcripts, model
artifacts, local paths, generated archives, or installer backups. The public
safety scan is a backstop, not a substitute for reviewing the staged diff.

NInfer engine changes belong in an NInfer fork rather than this client repository.
