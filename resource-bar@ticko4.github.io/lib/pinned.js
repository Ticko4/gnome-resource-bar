// Pinned panel: the menu's cards in a floating panel that stays on screen
// (above windows, fullscreen ones included) until it is unpinned. It has no
// menu actions and can be dragged anywhere; the extension keeps it updated
// even while a fullscreen app hides the top bar.

import Clutter from 'gi://Clutter';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {ResourcePopup} from './popup.js';

// Pointer travel (px) before a press becomes a drag, so clicks on the
// panel's buttons still work.
const DRAG_THRESHOLD = 6;
// Gap kept from the screen edges and below the top bar for a new panel.
const MARGIN = 8;

export class PinnedPanel {
    // x, y: saved stage position, or negative to place it on its own.
    constructor(extension, x, y) {
        this._ext = extension;
        this.popup = new ResourcePopup(extension, {pinned: true});
        const content = new St.BoxLayout({style_class: 'popup-menu-content'});
        content.add_child(this.popup.item);
        // Same classes as a menu, so it follows the shell theme.
        this.actor = new St.Bin({
            style_class: 'popup-menu resource-bar-pinned',
            reactive: true,
            child: content,
        });
        try {
            // Above windows, and still shown over fullscreen ones.
            Main.layoutManager.addChrome(this.actor, {trackFullscreen: false});
        } catch (e) {
            this.actor.destroy();
            throw e;
        }

        this.actor.connect('captured-event', (_actor, event) => this._onEvent(event));
        // Keep it on screen when monitors change or the panel grows.
        this._monitorsId = Main.layoutManager.connect('monitors-changed', () => this._clamp());
        this.actor.connect('notify::height', () => this._clamp());

        if (x < 0 || y < 0)
            [x, y] = this._defaultPosition();
        this._moveTo(x, y);
    }

    // Top right of the primary monitor, under the top bar.
    _defaultPosition() {
        const m = Main.layoutManager.primaryMonitor;
        const [, width] = this.actor.get_preferred_width(-1);
        return [m.x + m.width - width - MARGIN, m.y + Main.panel.height + MARGIN];
    }

    // Moves to (x, y), kept inside the monitor it is mostly on.
    _moveTo(x, y) {
        const [, width] = this.actor.get_preferred_width(-1);
        const [, height] = this.actor.get_preferred_height(width);
        const rect = new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width, height});
        let index = global.display.get_monitor_index_for_rect(rect);
        if (index < 0)
            index = Main.layoutManager.primaryIndex;
        const m = Main.layoutManager.monitors[index] ?? Main.layoutManager.primaryMonitor;
        const cx = Math.min(Math.max(x, m.x), m.x + Math.max(0, m.width - width));
        const cy = Math.min(Math.max(y, m.y), m.y + Math.max(0, m.height - height));
        this.actor.set_position(Math.round(cx), Math.round(cy));
    }

    _clamp() {
        if (!this._drag)
            this._moveTo(this.actor.x, this.actor.y);
    }

    // Press anywhere on the panel and move to drag it; a press that does not
    // move goes on to the button under it.
    _onEvent(event) {
        const type = event.type();
        if (type === Clutter.EventType.BUTTON_PRESS && event.get_button() === Clutter.BUTTON_PRIMARY) {
            const [px, py] = event.get_coords();
            this._endDrag();
            this._drag = {px, py, x: this.actor.x, y: this.actor.y, moving: false};
            // Keep receiving motion when the pointer leaves the panel.
            this._grab = global.stage.grab(this.actor);
            return Clutter.EVENT_PROPAGATE;
        }
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;

        if (type === Clutter.EventType.MOTION) {
            const [px, py] = event.get_coords();
            const dx = px - this._drag.px;
            const dy = py - this._drag.py;
            if (!this._drag.moving && Math.hypot(dx, dy) < DRAG_THRESHOLD)
                return Clutter.EVENT_PROPAGATE;
            this._drag.moving = true;
            this._moveTo(this._drag.x + dx, this._drag.y + dy);
            return Clutter.EVENT_STOP;
        }
        if (type === Clutter.EventType.BUTTON_RELEASE) {
            const moved = this._drag.moving;
            this._endDrag();
            if (!moved)
                return Clutter.EVENT_PROPAGATE;
            this._ext.savePinnedPosition(this.actor.x, this.actor.y);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _endDrag() {
        this._grab?.dismiss();
        this._grab = null;
        this._drag = null;
    }

    destroy() {
        this._endDrag();
        if (this._monitorsId) {
            Main.layoutManager.disconnect(this._monitorsId);
            this._monitorsId = 0;
        }
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }
}
