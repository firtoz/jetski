# Jetski 0.2.1

### Patch Changes

- f3067ed: Add optional bounded two-slot checkpoint upload staging with ordered verified
  acknowledgements, fencing and restart-safe cleanup. Serial uploads remain the
  default: a controlled R2 comparison showed no material speedup from overlap.
