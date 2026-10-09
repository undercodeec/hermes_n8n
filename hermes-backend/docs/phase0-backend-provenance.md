# Backend image provenance (prepared; not deployed)

The versioned Dockerfile rejects a missing or malformed full Git SHA and writes
`org.opencontainers.image.revision` on the production image. The versioned
Compose build requires `BACKEND_GIT_COMMIT`. This does not assign a commit to
the image currently served on the VPS.

## Candidate build in a clean checkout

Use a committed, clean checkout and a unique immutable tag. The command refuses
`latest` and writes a non-sensitive manifest outside the repository:

```sh
cd hermes-backend
node scripts/build-backend-release.mjs \
  --tag hermes-backend-app:COMMIT-SPECIFIC-CANDIDATE \
  --manifest /var/tmp/hermes-backend-candidate-manifest.json
```

The manifest contains the Git SHA, immutable tag, local image ID, optional
registry digest, and image creation time. A local image ID is not a registry
manifest digest. After pushing an approved candidate, obtain its registry
digest from the registry, inspect that exact local image, and regenerate the
manifest with `--repo-digest`. The generator rejects a digest absent from the
inspected image. Sign and retain the final manifest through the approved CI
artifact/signing system; no signing key or external destination is assumed here.

## Publication in a separate approved session

1. Record the currently served image ID, its immutable rollback reference,
   service state and backup reference without printing secrets.
2. Use the approved release checkout and set `BACKEND_GIT_COMMIT` to its full
   `git rev-parse HEAD`; require a clean checkout. Build the backend through the
   versioned Compose with that argument, then tag the resulting image with an
   immutable commit-specific tag and generate its manifest.
3. Verify that the manifest's `imageId` and `gitCommit` equal the image ID and
   OCI revision on the candidate image. Deploy only that inspected image; do
   not use `latest` as revision evidence.
4. After the approved service update, inspect the **served** container's image
   ID and revision label and require both to match the release manifest. Record
   the deployment timestamp and CI artifact reference.

## Rollback in that publication session

If health or the served ID/label check fails, restore the recorded prior image
reference with the approved Compose procedure, recreate only the backend app,
and verify the previous service state and image ID. Keep the failed candidate
and manifest for diagnosis. A rollback to an older image without provenance
must be recorded as such; it does not close digest-to-commit traceability.
