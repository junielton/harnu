/**
 * jsdom SVG geometry shim — TEST INFRASTRUCTURE ONLY.
 *
 * jsdom implements the SVG DOM tree but none of its geometry: no `DOMMatrix`,
 * no `createSVGMatrix`/`createSVGPoint`/`createSVGTransform`, no `getCTM`,
 * no `getBBox`. AntV X6 (like every SVG library) uses all of them, so a graph
 * cannot be constructed under jsdom without them — the failure is
 * `TypeError: this.viewport.getCTM is not a function`.
 *
 * This is a POLYFILL of a jsdom gap, not a stub of X6: the matrix maths below
 * is the exact 2D affine algebra the browser implements, so anything asserted
 * against it (a zoom factor, a translation, a rendered `transform` attribute)
 * is asserted against real behaviour. Electron's Chromium provides all of it
 * natively, so nothing here ships.
 *
 * Deliberately NOT shimmed: `getBBox` returns a zero box. jsdom does no layout,
 * so there is no honest width to report — a fabricated one would make
 * layout-dependent assertions (fit-to-content, label auto-sizing) LOOK
 * meaningful while measuring nothing. Those are on the human-verification list
 * (spec §10) for exactly this reason.
 */

interface MatrixLike {
  a: number
  b: number
  c: number
  d: number
  e: number
  f: number
}

/** The 2D affine subset of `DOMMatrix` that X6 exercises. */
class Mat2D implements MatrixLike {
  a = 1
  b = 0
  c = 0
  d = 1
  e = 0
  f = 0

  constructor(source?: Partial<MatrixLike>) {
    if (source) Object.assign(this, source)
  }

  /** `this × other`, in the SVG (column-vector) convention. */
  multiply(other: MatrixLike): Mat2D {
    return new Mat2D({
      a: this.a * other.a + this.c * other.b,
      b: this.b * other.a + this.d * other.b,
      c: this.a * other.c + this.c * other.d,
      d: this.b * other.c + this.d * other.d,
      e: this.a * other.e + this.c * other.f + this.e,
      f: this.b * other.e + this.d * other.f + this.f
    })
  }

  translate(tx = 0, ty = 0): Mat2D {
    return this.multiply({ a: 1, b: 0, c: 0, d: 1, e: tx, f: ty })
  }

  scale(sx = 1, sy = sx): Mat2D {
    return this.multiply({ a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 })
  }

  scaleNonUniform(sx = 1, sy = 1): Mat2D {
    return this.scale(sx, sy)
  }

  rotate(deg = 0): Mat2D {
    const rad = (deg * Math.PI) / 180
    const cos = Math.cos(rad)
    const sin = Math.sin(rad)
    return this.multiply({ a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 })
  }

  flipX(): Mat2D {
    return this.scale(-1, 1)
  }

  flipY(): Mat2D {
    return this.scale(1, -1)
  }

  inverse(): Mat2D {
    const det = this.a * this.d - this.b * this.c
    if (det === 0) return new Mat2D()
    return new Mat2D({
      a: this.d / det,
      b: -this.b / det,
      c: -this.c / det,
      d: this.a / det,
      e: (this.c * this.f - this.d * this.e) / det,
      f: (this.b * this.e - this.a * this.f) / det
    })
  }
}

class Point2D {
  x = 0
  y = 0
  matrixTransform(m: MatrixLike): Point2D {
    const p = new Point2D()
    p.x = m.a * this.x + m.c * this.y + m.e
    p.y = m.b * this.x + m.d * this.y + m.f
    return p
  }
}

/** An `SVGTransform` stand-in: X6 only ever sets and reads its matrix. */
class Transform2D {
  matrix: Mat2D = new Mat2D()
  setMatrix(m: MatrixLike): void {
    this.matrix = new Mat2D(m)
  }
}

/**
 * jsdom performs no layout, so an element's box never changes and there is
 * genuinely nothing to observe. Registering this rather than leaving
 * `ResizeObserver` undefined keeps the pane's own resize wiring on its normal
 * path instead of taking a `typeof === 'undefined'` branch tests never exercise.
 */
class NoopResizeObserver {
  observe(): void {
    return undefined
  }
  unobserve(): void {
    return undefined
  }
  disconnect(): void {
    return undefined
  }
}

let installed = false

/**
 * Install the shim on the current jsdom `window`. Idempotent, so a suite can
 * call it from more than one file without fighting itself.
 */
export function installJsdomSvgShim(): void {
  if (installed || typeof window === 'undefined') return
  installed = true

  const svgProto = window.SVGSVGElement.prototype as unknown as Record<string, unknown>
  svgProto.createSVGMatrix = function createSVGMatrix(): Mat2D {
    return new Mat2D()
  }
  svgProto.createSVGPoint = function createSVGPoint(): Point2D {
    return new Point2D()
  }
  svgProto.createSVGTransform = function createSVGTransform(): Transform2D {
    return new Transform2D()
  }
  svgProto.createSVGTransformFromMatrix = function createSVGTransformFromMatrix(
    m: MatrixLike
  ): Transform2D {
    const t = new Transform2D()
    t.setMatrix(m)
    return t
  }

  const gfxProto = window.SVGElement.prototype as unknown as Record<string, unknown>
  // The identity CTM is the CORRECT answer here, not a convenient one: X6 reads
  // `getCTM()` only to seed its cache before it has written any transform, and
  // an un-transformed viewport genuinely is the identity.
  gfxProto.getCTM = function getCTM(): Mat2D {
    return new Mat2D()
  }
  gfxProto.getScreenCTM = function getScreenCTM(): Mat2D {
    return new Mat2D()
  }
  gfxProto.getBBox = function getBBox(): { x: number; y: number; width: number; height: number } {
    return { x: 0, y: 0, width: 0, height: 0 }
  }

  if (typeof (window as unknown as Record<string, unknown>).DOMMatrix === 'undefined') {
    ;(window as unknown as Record<string, unknown>).DOMMatrix = Mat2D
  }
  if (typeof (globalThis as Record<string, unknown>).ResizeObserver === 'undefined') {
    ;(globalThis as Record<string, unknown>).ResizeObserver = NoopResizeObserver
  }
}

/**
 * A container carrying the layout jsdom will not compute. X6 sizes itself from
 * `clientWidth`/`clientHeight`, which are always 0 under jsdom.
 */
export function svgHost(width = 800, height = 600): HTMLElement {
  const el = document.createElement('div')
  Object.defineProperty(el, 'clientWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'clientHeight', { value: height, configurable: true })
  Object.defineProperty(el, 'offsetWidth', { value: width, configurable: true })
  Object.defineProperty(el, 'offsetHeight', { value: height, configurable: true })
  el.getBoundingClientRect = () =>
    ({ x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height }) as DOMRect
  document.body.appendChild(el)
  return el
}
