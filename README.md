# Wild Resi-Dance

A web synth for drones, noise and soft pulses, made to be played from a phone on stage at the Wild Residence show.

Play it at https://templeoflum.github.io/wild-resi-dance/

## Controls

- **Start / Stop**: fades the sound in and out.
- **Key**: root note (‹ ›) and chord: Fifth, Minor, Sus, Open.
- **Voices**: Drone level, Noise level with Pink or Brown colour, and Pulse depth.
- **Pulse rate**: BPM (− +, hold to run), Tap tempo, and ½ × / 2 × to step the pulse along note values (8 bars, 4 bars, 2 bars, 1 bar, ½, ¼, ⅛, ⅛ triplet, 1/16, 1/32, 1/64; default ¼, one per beat; the fast end is a buzz), shown next to the BPM.
- **Tone**: Bright (filter) and Space (reverb and delay).
- **Out**: Master level, into a gentle limiter.

Faders move by dragging, so a stray touch never jumps a level. Settings are kept on the device.

## How it works

Plain HTML, CSS and JavaScript with the Web Audio API. No build step, no dependencies and no network requests beyond its own files.

- **Drone**: three chord tones, each two detuned saw oscillators, plus a sine at the root, through a slowly drifting low-pass filter.
- **Noise**: looped pink or brown noise, high-passed and low-passed.
- **Pulse**: a smooth swell waveform that moves the level and the drone filter, in time with the BPM.
- **Space**: a generated convolution reverb and a dotted-eighth delay.
- **Output**: a compressor and a soft clipper keep it from clipping. Every change is ramped.

On phones the sound plays through an `<audio>` element fed by a MediaStream, so the system treats it as media. The page also asks for a screen wake lock, sets Media Session details, and resumes audio when it comes back into view. A service worker keeps it working offline once loaded, and it can be added to the home screen.

## Run locally

```
python3 -m http.server 8000
```

Then open http://localhost:8000/.
