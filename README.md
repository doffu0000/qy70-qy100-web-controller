# QY70 / QY100 Web Console

A browser-based Web MIDI app for controlling Yamaha QY70/QY100 hardware synthesizers.

## Hardware quirks

- **Drum Setup only has three editable slots, each hardwired to a fixed MIDI channel.**
  The QY70/QY100's Drum Setup screen can only ever be showing one of three slots - Ds1
  and Ds2 (Song mode) or Ds3 (Pattern mode) - and each slot always corresponds to the
  same MIDI channel regardless of what channel a track is actually assigned to elsewhere:

  | Slot | MIDI Channel |
  | ---- | ------------ |
  | Ds1  | 1            |
  | Ds2  | 2            |
  | Ds3  | 3            |

  There's no way to select Ds1/Ds2/Ds3 over MIDI - it has to be selected on the device
  itself (open its Drum Edit screen) before any live Drum Setup edits from the web
  console will land anywhere. This is why "Push Parameters" asks which of Ds1/Ds2/Ds3 is
  currently open on the device rather than using the connect bar's Channel selector.

- **Most parameters don't survive a song/pattern reload unless they're recorded as an
  actual event in the track.** The QY70/QY100 keeps one small persistent per-song/pattern
  "setup" data structure (reached via SONG VOICE / SONG EFFECT mode on the device) that
  gets re-applied automatically on load, with no recording needed. It only covers, per
  Multi Part: Bank Select + Program Number (Voice), Volume, Pan, Reverb/Chorus/Variation
  Send, Filter Cutoff Frequency, Filter Resonance, and EG Attack/Decay/Release Time; per
  Reverb/Chorus/Variation: the effect Type; and per Drum Setup note: Pitch Coarse, Level,
  Pan, Reverb Send Level, Variation Send Level, Filter Cutoff Frequency, and Filter
  Resonance (same for Ds1/Ds2/Ds3, since they share the same underlying data). Every
  other parameter - Portamento Switch, Mono/Poly Mode, Vibrato, Pitch EG, all of System,
  and most other Multi Part/effect detail parameters - only sticks if a real event for it
  exists in the recorded track, confirmed directly in `QY100 Manual.pdf`'s Troubleshooting
  appendix: *"When the song starts, the voice or effect settings that you have made
  disappear"* → *"Does the beginning of the song contain data which resets the tone
  generator?"*. This is exactly what Punch Insert and Rec-Arm Insert are for.

  Not yet confirmed: the exact "main parameters" the Reverb/Chorus/Variation Edit screens
  expose per effect Type (it varies by Type and isn't itemized as manual text - it's a
  table in the Data List PDF), and whether System-level parameters (Master Tune/Volume/
  Transpose) have an equivalent persistent slot. None of this has been independently
  verified against real hardware yet either - it's sourced from `QY100 Manual.pdf` alone.

## Ideas for later

- **"SPP Punch Insert" - locate to a Measure/Clock before punching in a parameter.**
  Tried and removed for now; it "sort of" worked and could be worth revisiting. The idea:
  a button, usable in Song mode with REPL/OVER/MULTI recording armed, that prompts for a
  Measure and Clock position, converts that to a Song Position Pointer value, and relocates
  the QY70/QY100 there before sending the parameter - useful for punching a change in at an
  exact spot rather than whenever you happen to click.

  What was actually implemented: a bare SPP message (`F2`) sent while the device was
  already rolling did not relocate it in practice. Switching to **Stop (`FC`) → SPP (`F2`)
  → Continue (`FB`)** - matching the general MIDI convention that SPP only sets where the
  *next* Continue resumes from - got partial results ("sort of works"), reusing the same
  MIDI Clock generator Rec-Arm Insert already has (Continue needs an ongoing Clock stream
  behind it, same as Start does). Still needs real hardware testing to nail down why it's
  not fully reliable - possibilities include Clock/Continue timing relative to the SPP
  message, or the QY70/QY100 needing to already be fully stopped (not just armed) for SPP
  to land cleanly.

  The Measure/Clock → SPP conversion also assumes a constant 4/4 time signature (SPP's
  native unit is a 16th-note count since the top of the song, with no concept of
  "measure"), which would be wrong for any song with meter changes or non-4/4 sections -
  worth asking for a time signature too if this gets rebuilt.

## License

Copyright (C) 2026 Doffu (<https://qy100.doffu.net/>)

This program is free software: you can redistribute it and/or modify
it under the terms of the GNU General Public License as published by
the Free Software Foundation, either version 3 of the License, or
(at your option) any later version.

This program is distributed in the hope that it will be useful,
but WITHOUT ANY WARRANTY; without even the implied warranty of
MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
GNU General Public License for more details.

You should have received a copy of the GNU General Public License
along with this program. If not, see <https://www.gnu.org/licenses/>.

If this project has been useful to you, consider supporting future work
on Patreon: <https://www.patreon.com/doffu>.
