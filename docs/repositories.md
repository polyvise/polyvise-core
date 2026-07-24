# Repository Layout

The Polyvise organization uses independent release units:

| Repository | Responsibility |
| --- | --- |
| `polyvise/polyvise-core` | Core library |
| `polyvise/polyvise-ai` | `polyvise.ai` website |
| `polyvise/debatefrog` | `debatefrog.com` reference implementation |

Application repositories consume a released version of `@polyvise/core`. They do not import source files from sibling repositories.

Core changes should be verified in this repository, released with semantic versioning, and then adopted intentionally by each application. Debatefrog is the first compatibility target and reference consumer.
