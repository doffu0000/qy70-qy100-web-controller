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
