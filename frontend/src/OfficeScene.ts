import Phaser from "phaser";
import {
  createStaff,
  type Point,
  type Staff,
  type StaffId,
} from "./simulation";

type Actor = {
  sprite: Phaser.GameObjects.Image;
  label: Phaser.GameObjects.Text;
  bubble: Phaser.GameObjects.Text;
  path: Point[];
  target: Point;
  model: Staff;
  clock: number;
};
const W = 960,
  H = 664;
const font = '"Malgun Gothic", "Apple SD Gothic Neo", sans-serif';

/** Purely visual scene. React's simulation state owns all task state. No AI calls. */
export class OfficeScene extends Phaser.Scene {
  private actors = new Map<StaffId, Actor>();
  private paint!: Phaser.GameObjects.Graphics;
  private reduced = window.matchMedia("(prefers-reduced-motion: reduce)")
    .matches;
  private motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
  private motionChange = (e: MediaQueryListEvent) => {
    this.reduced = e.matches;
  };
  constructor(
    private initial: Staff[],
    private select: (id: StaffId) => void,
  ) {
    super("office");
  }

  create() {
    this.paint = this.add.graphics();
    this.drawMap();
    this.motionQuery.addEventListener("change", this.motionChange);
    this.initial.forEach((person, index) => {
      this.makeTextures(person, index);
      const sprite = this.add
        .image(person.home.x, person.home.y, `${person.id}-0`)
        .setScale(1.65)
        .setOrigin(0.5, 1)
        .setDepth(20)
        .setInteractive({ useHandCursor: true });
      const label = this.add
        .text(sprite.x, sprite.y + 7, person.name, {
          fontFamily: font,
          fontSize: "12px",
          color: "#334c40",
          backgroundColor: "#fcfaf2",
          padding: { x: 6, y: 3 },
        })
        .setOrigin(0.5, 0)
        .setDepth(30);
      const bubble = this.add
        .text(sprite.x, sprite.y - 63, "", {
          fontFamily: font,
          fontSize: "11px",
          color: "#ffffff",
          backgroundColor: "#345c4a",
          padding: { x: 7, y: 4 },
        })
        .setOrigin(0.5, 1)
        .setDepth(31)
        .setVisible(false);
      sprite.on("pointerdown", () => this.select(person.id));
      sprite.on("pointerover", () => {
        sprite.setTint(0xffeeb5);
      });
      sprite.on("pointerout", () => {
        sprite.clearTint();
      });
      this.actors.set(person.id, {
        sprite,
        label,
        bubble,
        path: [],
        target: person.home,
        model: person,
        clock: 0,
      });
    });
    this.sync(this.initial);
    this.game.events.on("office:state", this.sync, this);
    this.events.once(Phaser.Scenes.Events.SHUTDOWN, () => {
      this.game.events.off("office:state", this.sync, this);
      this.motionQuery.removeEventListener("change", this.motionChange);
      this.actors.clear();
    });
  }

  private rect(x: number, y: number, w: number, h: number, color: number) {
    this.paint.fillStyle(color).fillRect(x, y, w, h);
  }
  private text(
    x: number,
    y: number,
    value: string,
    size = 13,
    color = "#567060",
  ) {
    return this.add
      .text(x, y, value, { fontFamily: font, fontSize: `${size}px`, color })
      .setDepth(5);
  }
  private plant(x: number, y: number) {
    this.rect(x - 9, y + 4, 18, 13, 0xba8761);
    this.rect(x - 11, y, 22, 5, 0xd3a67b);
    this.rect(x - 3, y - 18, 6, 20, 0x567c43);
    this.rect(x - 13, y - 16, 11, 10, 0x7e9f5e);
    this.rect(x + 1, y - 24, 10, 13, 0x8caa66);
    this.rect(x - 8, y - 27, 9, 12, 0x648851);
  }
  private desk(x: number, y: number, accent: number) {
    this.rect(x - 55, y + 14, 120, 15, 0x000000);
    this.paint.setAlpha(1);
    this.rect(x - 60, y - 14, 120, 46, 0xae845c);
    this.rect(x - 60, y - 18, 120, 43, 0xe6c69a);
    this.rect(x - 56, y - 15, 112, 3, 0xf4dbb7);
    this.rect(x - 23, y - 37, 46, 29, 0x455c56);
    this.rect(x - 19, y - 33, 38, 21, 0x9ac0b7);
    this.rect(x - 15, y - 29, 20, 3, 0xe1eee3);
    this.rect(x - 15, y - 23, 29, 2, 0xc7ded2);
    this.rect(x - 3, y - 8, 6, 9, 0x5e7064);
    this.rect(x - 13, y + 1, 26, 4, 0x6f7e71);
    this.rect(x - 19, y + 10, 38, 9, 0xf5eedb);
    this.rect(x + 31, y - 4, 17, 22, accent);
    this.rect(x + 34, y - 1, 11, 2, 0xfff7df);
    this.rect(x - 43, y + 1, 10, 12, 0xf8f4e8);
    this.rect(x - 40, y - 3, 4, 6, 0x6f9974);
    this.rect(x - 17, y + 43, 34, 19, accent);
    this.rect(x - 14, y + 60, 28, 8, 0x596c60);
    this.rect(x - 3, y + 65, 6, 12, 0x596c60);
    this.rect(x - 16, y + 74, 32, 4, 0x596c60);
  }
  private shelf(x: number, y: number, colors: number[]) {
    this.rect(x, y, 58, 43, 0x9c805c);
    this.rect(x + 3, y + 3, 52, 36, 0xc8ad83);
    colors.forEach((c, i) => this.rect(x + 7 + i * 10, y + 8, 7, 25, c));
    this.rect(x - 1, y + 35, 60, 6, 0x9c805c);
  }
  private drawMap() {
    this.cameras.main.setBackgroundColor("#ecede1");
    this.rect(14, 30, W - 28, H - 42, 0xc4cdb8);
    this.rect(22, 38, W - 44, H - 58, 0xe5e2cb);
    for (let y = 40; y < H - 20; y += 24) {
      this.rect(22, y, W - 44, 1, 0xd7d6bf);
      for (let x = 22 + (y % 48 === 16 ? 0 : 32); x < W - 22; x += 64)
        this.rect(x, y, 1, 24, 0xd7d6bf);
    }
    const shades = [0xece7d3, 0xe0e9e3, 0xe6e9d7, 0xebe3eb, 0xefe2da, 0xdeebe6];
    createStaff().forEach((person, i) => {
      const x = 32 + (i % 3) * 300,
        y = i < 3 ? 56 : 352;
      this.rect(x, y, 280, 202, shades[i]);
      // Pixel walls and open doorways along the central corridor.
      this.rect(x - 4, y - 10, 288, 12, 0xa3b19b);
      this.rect(x - 4, y + 2, 4, 200, 0xb6c2ab);
      this.rect(x + 280, y + 2, 4, 200, 0xb6c2ab);
      if (i < 3) {
        this.rect(x, y + 198, 96, 7, 0xa3b19b);
        this.rect(x + 180, y + 198, 100, 7, 0xa3b19b);
      } else {
        this.rect(x, y - 10, 96, 12, 0xa3b19b);
        this.rect(x + 96, y - 10, 84, 12, 0xe5e2cb);
      }
      this.rect(x + 10, y + 9, 135, 25, 0xf9f7ee);
      this.rect(
        x + 10,
        y + 9,
        4,
        25,
        Phaser.Display.Color.HexStringToColor(person.color).color,
      );
      this.text(x + 23, y + 15, person.room, 13, "#44574c");
      // Window, rug, desk and a bookcase make each room readable at small sizes.
      this.rect(x + 177, y + 8, 75, 37, 0xb0c1b2);
      this.rect(x + 181, y + 11, 67, 28, 0xd2e9e2);
      this.rect(x + 211, y + 11, 4, 28, 0xf8f5e4);
      this.rect(x + 174, y + 39, 81, 6, 0xf8f5e4);
      this.rect(x + 75, y + 76, 138, 104, i % 2 ? 0xc8d9cc : 0xdcd1b9);
      this.rect(x + 80, y + 81, 128, 94, i % 2 ? 0xd2e2d5 : 0xe5dbc5);
      this.desk(
        x + 136,
        y + 94,
        Phaser.Display.Color.HexStringToColor(person.color).color,
      );
      this.shelf(x + 12, y + 92, [0x779a8c, 0xc58f75, 0xe9d296, 0x8ba4b5]);
      this.plant(x + 250, y + 168);
      if (i === 2) {
        this.rect(x + 16, y + 48, 45, 28, 0xb6c1a0);
        this.rect(x + 19, y + 51, 39, 22, 0xf8f3dc);
      }
      if (i === 4) {
        this.rect(x + 16, y + 48, 45, 28, 0xc39c8b);
        this.rect(x + 20, y + 52, 18, 20, 0xd3a3a4);
        this.rect(x + 39, y + 52, 18, 20, 0x97b6a4);
      }
    });
    // Entry, lounge, shared review table and decor.
    this.text(42, 282, "← 휴게 공간", 11, "#7e8b78");
    this.text(800, 282, "공용 검수 공간 ↓", 11, "#7e8b78");
    this.rect(32, 576, 526, 66, 0xd7dfcb);
    this.rect(624, 576, 288, 66, 0xd6dfd7);
    this.text(46, 584, "휴게 공간", 12, "#54705c");
    this.text(800, 584, "공용 검수 공간", 12, "#54705c");
    this.rect(159, 597, 102, 31, 0x81997d);
    this.rect(155, 591, 110, 14, 0xa3b49b);
    this.rect(155, 604, 8, 25, 0x6c866c);
    this.rect(257, 604, 8, 25, 0x6c866c);
    this.rect(181, 603, 35, 20, 0xa3b49b);
    this.rect(220, 603, 32, 20, 0xa3b49b);
    this.rect(299, 602, 63, 24, 0xbe9e70);
    this.rect(299, 598, 63, 24, 0xe4c99f);
    this.rect(320, 600, 15, 12, 0xeff1df);
    this.plant(399, 609);
    this.rect(681, 587, 42, 45, 0xae8d65);
    this.rect(678, 583, 48, 45, 0xe0c49b);
    this.rect(687, 589, 22, 14, 0xf9f2df);
    this.rect(689, 592, 15, 2, 0x8ea89a);
    this.plant(884, 625);
    this.text(35, 9, "모아 교육운영 오피스", 12, "#6f8270");
    this.text(751, 9, "6명 · 역할 시뮬레이션", 12, "#6f8270");
  }

  private makeTextures(person: Staff, index: number) {
    const hair = [0x604939, 0x394c58, 0x65523d, 0x544553, 0x754c42, 0x3e544c][
      index
    ];
    const shirt = Phaser.Display.Color.HexStringToColor(person.color).color;
    for (let frame = 0; frame < 4; frame++) {
      const g = this.make.graphics({ x: 0, y: 0 });
      const r = (x: number, y: number, w: number, h: number, color: number) =>
        g.fillStyle(color).fillRect(x, y, w, h);
      g.fillStyle(0x61745c, 0.22).fillEllipse(12, 31, 20, 5);
      const bob = frame % 2;
      r(6, 3 + bob, 12, 12, hair);
      r(4, 7 + bob, 16, 7, hair);
      r(7, 7 + bob, 10, 9, 0xe8ba94);
      r(7, 5 + bob, 10, 4, hair);
      r(8, 10 + bob, 2, 2, 0x3e423c);
      r(14, 10 + bob, 2, 2, 0x3e423c);
      r(9, 14 + bob, 6, 2, 0xf3d1ab);
      r(6, 16 + bob, 12, 10, shirt);
      r(4, 17 + bob, 3, 8 - bob, shirt);
      r(17, 17, 3, 8, shirt);
      r(4, 23 - bob, 3, 3, 0xe8ba94);
      r(17, 23 + bob, 3, 3, 0xe8ba94);
      r(7, 25, 5, frame === 1 ? 5 : 6, 0x4f5c58);
      r(13, 25, 4, frame === 3 ? 5 : 6, 0x4f5c58);
      r(6, frame === 1 ? 29 : 30, 6, 3, 0x3a4845);
      r(13, frame === 3 ? 29 : 30, 6, 3, 0x3a4845);
      if (index === 1) {
        r(7, 10 + bob, 5, 3, 0x50656d);
        r(13, 10 + bob, 5, 3, 0x50656d);
      }
      if (index === 4) r(17, 6 + bob, 4, 4, 0xd6a3a5);
      g.generateTexture(`${person.id}-${frame}`, 24, 36);
      g.destroy();
    }
  }

  sync(people: Staff[]) {
    people.forEach((person) => {
      const actor = this.actors.get(person.id);
      if (!actor) return;
      if (
        actor.target.x !== person.target.x ||
        actor.target.y !== person.target.y
      ) {
        const { x, y } = actor.sprite;
        const t = person.target;
        // Travel through open corridors, rather than straight through office walls.
        const sourceDoor =
          168 + Math.max(0, Math.min(2, Math.floor((x - 32) / 300))) * 300;
        const targetDoor = 168 + Math.floor((t.x - 32) / 300) * 300;
        const sourceInRoom = x < 916 && (y < 270 || (y > 350 && y < 555));
        const exit = sourceInRoom
          ? [
              { x: sourceDoor, y },
              { x: sourceDoor, y: 310 },
            ]
          : [{ x, y: 310 }];
        let path: Point[];
        if (t.y > 570 && y > 570) path = [t];
        else if (t.y > 570 && y < 350)
          path = [...exit, { x: 929, y: 310 }, { x: 929, y: t.y }, t];
        else if (t.y > 570)
          path = [{ x, y: 561 }, { x: 929, y: 561 }, { x: 929, y: t.y }, t];
        else if (y > 570)
          path = [
            { x: 929, y },
            { x: 929, y: 310 },
            { x: targetDoor, y: 310 },
            { x: targetDoor, y: t.y },
            t,
          ];
        else if (
          sourceInRoom &&
          Math.floor((x - 32) / 300) === Math.floor((t.x - 32) / 300) &&
          y < 280 === t.y < 280
        )
          path = [{ x: t.x, y }, t];
        else
          path = [
            ...exit,
            { x: targetDoor, y: 310 },
            { x: targetDoor, y: t.y },
            t,
          ];
        actor.path = path;
        actor.target = { ...t };
      }
      actor.model = person;
      if (person.status === "오류 발생") actor.path = [];
      actor.bubble
        .setText(person.status)
        .setVisible(person.status !== "대기 중");
      actor.bubble.setBackgroundColor(
        person.status === "오류 발생" ? "#a44e43" : "#345c4a",
      );
    });
  }

  update(_time: number, delta: number) {
    this.actors.forEach((actor) => {
      const point = actor.path[0];
      if (point) {
        const dx = point.x - actor.sprite.x,
          dy = point.y - actor.sprite.y;
        const distance = Math.hypot(dx, dy),
          step = (360 * Math.min(delta, 50)) / 1000;
        if (this.reduced) {
          actor.sprite.setPosition(actor.target.x, actor.target.y);
          actor.path = [];
        } else if (distance <= step) {
          actor.sprite.setPosition(point.x, point.y);
          actor.path.shift();
        } else {
          actor.sprite.x += (dx / distance) * step;
          actor.sprite.y += (dy / distance) * step;
        }
        actor.clock += delta;
        actor.sprite.setTexture(
          `${actor.model.id}-${this.reduced ? 0 : Math.floor(actor.clock / 130) % 4}`,
        );
      } else {
        actor.sprite.setTexture(`${actor.model.id}-0`);
        actor.sprite.setScale(
          1.65,
          this.reduced ? 1.65 : 1.65 + Math.sin(_time / 650) * 0.012,
        );
      }
      actor.label.setPosition(actor.sprite.x, actor.sprite.y + 3);
      actor.bubble.setPosition(actor.sprite.x, actor.sprite.y - 63);
      actor.sprite.setDepth(20 + actor.sprite.y / H);
    });
  }
}
