// QY70/QY100 Web Console
// Copyright (C) 2026 Doffu <https://qy100.doffu.net/>
// Licensed under the GNU General Public License v3.0 or later. See LICENSE.
// Support future development: <https://www.patreon.com/doffu>

// Thin wrapper around the Web MIDI API: device discovery, connect/select,
// and a single send/receive path everything else in the app builds on.

export class MidiLink {
  constructor() {
    this.access = null;
    this.input = null;
    this.output = null;
    this.onMessage = null; // (Uint8Array) => void
    this.onDevicesChanged = null; // () => void
  }

  async requestAccess() {
    if (!navigator.requestMIDIAccess) {
      throw new Error('Web MIDI API is not available in this browser (try Chrome or Edge).');
    }
    this.access = await navigator.requestMIDIAccess({ sysex: true });
    this.access.onstatechange = () => {
      if (this.onDevicesChanged) this.onDevicesChanged();
    };
    return this.access;
  }

  listInputs() {
    if (!this.access) return [];
    return Array.from(this.access.inputs.values());
  }

  listOutputs() {
    if (!this.access) return [];
    return Array.from(this.access.outputs.values());
  }

  selectInput(id) {
    if (this.input) this.input.onmidimessage = null;
    this.input = this.access.inputs.get(id) || null;
    if (this.input) {
      this.input.onmidimessage = (evt) => {
        if (this.onMessage) this.onMessage(evt.data);
      };
    }
  }

  selectOutput(id) {
    this.output = this.access.outputs.get(id) || null;
  }

  send(bytes) {
    if (!this.output) throw new Error('No MIDI output selected.');
    this.output.send(bytes);
  }
}
