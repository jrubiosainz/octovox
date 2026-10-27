# Third-party notices

Octovox includes or uses these third-party components. Their trademarks belong to their owners: Octovox is not created, sponsored or endorsed by GitHub or Microsoft.

| Component | Use in Octovox | License |
| --- | --- | --- |
| [Octicons](https://github.com/primer/octicons) © GitHub, Inc. | Interface icons (`ui/icons.svg`), including the Copilot icon to represent Copilot. | MIT, in [`licenses/octicons-MIT.txt`](licenses/octicons-MIT.txt). Use of GitHub's logos is also governed by the [GitHub logo guidelines](https://github.com/logos). |
| [Mona Sans](https://github.com/github/mona-sans) © The Mona Sans Project Authors | Typeface for the brand and headings (`ui/.fonts/MonaSans.woff2`, unmodified). | SIL Open Font License 1.1, in [`licenses/mona-sans-OFL.txt`](licenses/mona-sans-OFL.txt). Reserved font name: "Mona". |
| [mlx-whisper](https://github.com/ml-explore/mlx-examples) © Apple Inc. | Local speech recognition (`stt/.venv`, installed by `setup.sh`). | MIT. |
| [Whisper large-v3-turbo](https://github.com/openai/whisper) © OpenAI | Speech-recognition model (external weights, not included). | MIT. |
| GitHub Copilot app dictation sounds | Played from the installed app; never copied or redistributed. | Property of GitHub, Inc. |

## Online services

Octovox bundles no speech SDK. When you choose a cloud voice, it calls the endpoint you configure, under your own agreement with that provider:

- **Azure AI Speech and MAI-Voice** (Microsoft), through your Azure AI Foundry or Speech resource.
- **OpenAI-compatible speech APIs**, such as Azure OpenAI or OpenAI.

The Octovox mark, eight voice-wave bars, is an original design of this project.

"GitHub", "GitHub Copilot", the Invertocat logo and the Octocat are trademarks of GitHub, Inc. "Microsoft", "Azure" and "MAI" are trademarks of Microsoft Corporation.
