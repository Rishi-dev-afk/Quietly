'use client';

// ─────────────────────────────────────────────────────────────────────────
// BrainDiagram3D — drop-in replacement for the 2D SVG BrainDiagram.
//
// Same props, same visual language (dark canvas, organic glowing nodes,
// colored typed edges, hover tooltip, click-to-select, legend below),
// just rendered with Three.js instead of SVG.
//
// Install: npm install three
//
// In page.js:
//   import BrainDiagram3D from './BrainDiagram3D';
//   ...
//   <BrainDiagram3D
//     nodes={displayedSnapshot.nodes}
//     edges={displayedSnapshot.edges}
//     onNodeClick={selectMentalModelNode}
//     selectedNodeId={selectedNode?.id}
//   />
// (just swap <BrainDiagram ... /> for <BrainDiagram3D ... /> — props are identical)
// ─────────────────────────────────────────────────────────────────────────

import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const NODE_TYPE_COLORS = {
  emotion:      { glow: '#E0A98A', stroke: '#C98A63', text: '#F2E9DD' },
  theme:        { glow: '#9FB6C4', stroke: '#6E8B9C', text: '#EAF1F4' },
  pattern:      { glow: '#D8D0BC', stroke: '#AFA587', text: '#F2EEE2' },
  coping:       { glow: '#9AD6BC', stroke: '#5E9C82', text: '#E6F5EE' },
  relationship: { glow: '#C2AEDE', stroke: '#9078B8', text: '#F0EAF7' },
  tension:      { glow: '#E0A0A0', stroke: '#B86E6E', text: '#F7E9E9' },
};
const EDGE_COLORS = {
  fuels:          '#C98A63',
  conflicts_with: '#B86E6E',
  leads_to:       '#5E9C82',
  soothes:        '#7FB8A0',
  masks:          '#9078B8',
  orbits:         '#8A8A98',
};

const SCENE_RADIUS = 230; // bounds nodes roughly fit within, in 3D world units

function nodeRadius(weight) {
  return 8.5 + weight * 1.65; // ~ half the 2D radius, since perspective adds apparent size
}

// Same deterministic seeded RNG as the 2D version, so a node's organic shape and flicker
// timing stay stable across re-renders instead of jittering.
function seedRandom(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  return () => {
    h ^= h << 13; h >>>= 0;
    h ^= h >>> 17;
    h ^= h << 5; h >>>= 0;
    return (h % 1000) / 1000;
  };
}

// 3D analogue of the 2D force simulation — spaces nodes apart, pulls linked nodes together,
// keeps everything roughly bound to a sphere around the origin. No dependencies.
function simulateLayout3D(nodes, edges) {
  const ids = nodes.map((n) => n.id);
  const idx = {};
  ids.forEach((id, i) => (idx[id] = i));

  const sorted = [...nodes].sort((a, b) => b.weight - a.weight);
  const pos = nodes.map(() => new THREE.Vector3());
  sorted.forEach((node, i) => {
    if (i === 0) { pos[idx[node.id]].set(0, 0, 0); return; }
    const rand = seedRandom(node.id + 'pos');
    // Fibonacci-sphere-ish initial spread so nodes don't start coincident
    const phi = Math.acos(1 - 2 * (rand() * 0.7 + (i / nodes.length) * 0.3));
    const theta = 2 * Math.PI * rand() + i * 2.4;
    const r = 40 + i * 14;
    pos[idx[node.id]].set(
      r * Math.sin(phi) * Math.cos(theta),
      r * Math.sin(phi) * Math.sin(theta),
      r * Math.cos(phi)
    );
  });

  const vel = nodes.map(() => new THREE.Vector3());
  const links = edges
    .map((e) => ({ a: idx[e.source], b: idx[e.target], strength: e.strength || 1 }))
    .filter((l) => l.a !== undefined && l.b !== undefined);

  const n = nodes.length;
  const radii = nodes.map((node) => nodeRadius(node.weight));

  for (let tick = 0; tick < 240; tick++) {
    const damping = 0.84;

    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const delta = new THREE.Vector3().subVectors(pos[i], pos[j]);
        let dist = delta.length() || 0.01;
        const minDist = radii[i] + radii[j] + 16;
        const force = dist < minDist ? (minDist - dist) * 0.05 : 1800 / (dist * dist);
        delta.normalize().multiplyScalar(force);
        vel[i].add(delta);
        vel[j].sub(delta);
      }
    }

    links.forEach(({ a, b, strength }) => {
      const delta = new THREE.Vector3().subVectors(pos[b], pos[a]);
      const dist = delta.length() || 0.01;
      const targetLen = 70 - strength * 3.5;
      const force = (dist - targetLen) * 0.018 * (0.4 + strength * 0.15);
      delta.normalize().multiplyScalar(force);
      vel[a].add(delta);
      vel[b].sub(delta);
    });

    for (let i = 0; i < n; i++) {
      const pull = 0.01 + (1 - nodes[i].weight / 10) * 0.005;
      vel[i].addScaledVector(pos[i], -pull);
    }

    for (let i = 0; i < n; i++) {
      vel[i].multiplyScalar(damping);
      pos[i].add(vel[i]);
      const maxR = SCENE_RADIUS - radii[i];
      if (pos[i].length() > maxR) pos[i].setLength(maxR);
    }
  }

  const result = {};
  nodes.forEach((node, i) => (result[node.id] = pos[i]));
  return result;
}

function wrapLabel(label, maxChars) {
  const words = label.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (candidate.length > maxChars && line) {
      lines.push(line);
      line = word;
    } else {
      line = candidate;
    }
    if (lines.length === 1) break;
  }
  if (line) lines.push(line);
  return lines.slice(0, 2);
}

// Renders a node's wrapped label to a canvas, used as a billboard sprite texture.
function makeLabelTexture(label, color) {
  const lines = wrapLabel(label, 16);
  const canvas = document.createElement('canvas');
  const scale = 4; // supersample for crisp text
  canvas.width = 256 * scale;
  canvas.height = 80 * scale;
  const ctx = canvas.getContext('2d');
  ctx.scale(scale, scale);
  ctx.font = '500 15px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = color;
  const lineHeight = 18;
  const startY = 40 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((line, i) => ctx.fillText(line, 128, startY + i * lineHeight));
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

// Lumpy, organic node geometry — same spirit as the 2D blobPath, just a perturbed icosphere.
function makeBlobGeometry(radius, seed) {
  const geo = new THREE.IcosahedronGeometry(radius, 3);
  const rand = seedRandom(seed);
  const noiseSeeds = Array.from({ length: 6 }, () => ({
    dir: new THREE.Vector3(rand() - 0.5, rand() - 0.5, rand() - 0.5).normalize(),
    amp: 0.06 + rand() * 0.1,
    freq: 1.5 + rand() * 2,
  }));
  const pos = geo.attributes.position;
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i);
    const n = v.clone().normalize();
    let offset = 0;
    noiseSeeds.forEach((s) => {
      offset += Math.sin(n.dot(s.dir) * s.freq * Math.PI) * s.amp;
    });
    v.addScaledVector(n, offset * radius);
    pos.setXYZ(i, v.x, v.y, v.z);
  }
  geo.computeVertexNormals();
  return geo;
}

export default function BrainDiagram3D({ nodes, edges, onNodeClick, selectedNodeId }) {
  const mountRef = useRef(null);
  const [tooltip, setTooltip] = useState(null); // { node, screenX, screenY }
  const stateRef = useRef({});

  useEffect(() => {
    if (!mountRef.current || !nodes.length) return;
    const mount = mountRef.current;
    const width = mount.clientWidth;
    const height = mount.clientHeight;

    // ── Scene setup ──────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#0E0E14');
    scene.fog = new THREE.FogExp2(0x0e0e14, 0.0019);

    const camera = new THREE.PerspectiveCamera(50, width / height, 1, 2000);
    camera.position.set(0, 30, 420);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(width, height);
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    mount.innerHTML = '';
    mount.appendChild(renderer.domElement);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 120;
    controls.maxDistance = 900;
    controls.autoRotate = true;
    controls.autoRotateSpeed = 0.35;

    // Ambient + a couple of soft point lights for a moody, low-key look
    scene.add(new THREE.AmbientLight(0xffffff, 0.55));
    const key = new THREE.PointLight(0xffe7d2, 1.1, 1200, 1.6);
    key.position.set(150, 200, 250);
    scene.add(key);
    const rim = new THREE.PointLight(0x9fb6c4, 0.6, 1200, 1.6);
    rim.position.set(-200, -120, -200);
    scene.add(rim);

    // Subtle starfield-ish grain via sparse points, echoing the 2D grain filter
    {
      const starGeo = new THREE.BufferGeometry();
      const starCount = 260;
      const starPos = new Float32Array(starCount * 3);
      for (let i = 0; i < starCount; i++) {
        starPos[i * 3] = (Math.random() - 0.5) * 1400;
        starPos[i * 3 + 1] = (Math.random() - 0.5) * 1400;
        starPos[i * 3 + 2] = (Math.random() - 0.5) * 1400;
      }
      starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
      const starMat = new THREE.PointsMaterial({ color: 0xffffff, size: 1.1, transparent: true, opacity: 0.18 });
      scene.add(new THREE.Points(starGeo, starMat));
    }

    // ── Layout ───────────────────────────────────────────────────────
    const positions = simulateLayout3D(nodes, edges);

    // ── Nodes ────────────────────────────────────────────────────────
    const nodeGroup = new THREE.Group();
    scene.add(nodeGroup);
    const nodeMeshes = []; // { mesh, glow, ring, node, baseEmissive, phase }

    nodes.forEach((node, ni) => {
      const colors = NODE_TYPE_COLORS[node.type] || NODE_TYPE_COLORS.theme;
      const r = nodeRadius(node.weight);
      const pos = positions[node.id];

      const geo = makeBlobGeometry(r, node.id);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(colors.glow),
        emissive: new THREE.Color(colors.glow),
        emissiveIntensity: 0.55,
        roughness: 0.45,
        metalness: 0.1,
        transparent: true,
        opacity: 0.92,
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.copy(pos);
      mesh.userData.nodeId = node.id;
      mesh.scale.setScalar(0.001); // pop-in animation start

      // Wireframe stroke overlay, echoing the 2D blob outline
      const wireGeo = new THREE.IcosahedronGeometry(r * 1.015, 1);
      const wireMat = new THREE.MeshBasicMaterial({ color: colors.stroke, wireframe: true, transparent: true, opacity: 0.35 });
      const wire = new THREE.Mesh(wireGeo, wireMat);
      mesh.add(wire);

      // Soft glow halo (additive, billboard-like via sprite)
      const glowTexture = makeRadialGlowTexture(colors.glow);
      const glowMat = new THREE.SpriteMaterial({ map: glowTexture, color: new THREE.Color(colors.glow), transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
      const glow = new THREE.Sprite(glowMat);
      glow.scale.setScalar(r * 4.2);
      glow.position.copy(pos);

      // Label sprite
      const labelTexture = makeLabelTexture(node.label, colors.text);
      const labelMat = new THREE.SpriteMaterial({ map: labelTexture, transparent: true, depthWrite: false });
      const label = new THREE.Sprite(labelMat);
      const labelScale = Math.max(22, r * 1.7);
      label.scale.set(labelScale * 1.7, labelScale * 0.53, 1);
      // Sit the label below the node sphere rather than centered on it
      label.position.copy(pos).add(new THREE.Vector3(0, -(r + labelScale * 0.42), 0));

      // Selection ring (hidden unless selected)
      const ringGeo = new THREE.TorusGeometry(r + 6, 0.7, 8, 48);
      const ringMat = new THREE.MeshBasicMaterial({ color: colors.stroke, transparent: true, opacity: 0.7 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.copy(pos);
      ring.visible = false;

      scene.add(glow);
      scene.add(label);
      scene.add(ring);
      nodeGroup.add(mesh);

      nodeMeshes.push({
        mesh, glow, label, ring, node, colors,
        basePos: pos.clone(),
        phase: ni * 0.4,
        flickerSpeed: 3 + (ni % 4),
        popDelay: 0.05 + ni * 0.035,
      });
    });

    // ── Edges ────────────────────────────────────────────────────────
    const edgeGroup = new THREE.Group();
    scene.add(edgeGroup);
    const edgeLines = []; // { line, curve, material, particle, edge }

    edges.forEach((edge, ei) => {
      const s = positions[edge.source];
      const t = positions[edge.target];
      if (!s || !t) return;
      const color = EDGE_COLORS[edge.relationship] || '#8A8A98';
      const mid = new THREE.Vector3().addVectors(s, t).multiplyScalar(0.5);
      // bow the curve outward from the origin slightly, like the 2D quadratic curve
      const outward = mid.clone().normalize().multiplyScalar(18 + (edge.strength || 1) * 2);
      mid.add(outward);
      const curve = new THREE.QuadraticBezierCurve3(s, mid, t);
      const points = curve.getPoints(24);
      const geo = new THREE.BufferGeometry().setFromPoints(points);
      const mat = new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0 });
      const line = new THREE.Line(geo, mat);
      edgeGroup.add(line);

      let particle = null;
      if ((edge.strength || 1) >= 3) {
        const pGeo = new THREE.SphereGeometry(1.3, 8, 8);
        const pMat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0 });
        particle = new THREE.Mesh(pGeo, pMat);
        scene.add(particle);
      }

      edgeLines.push({ line, curve, material: mat, particle, edge, drawDelay: 0.15 + ei * 0.02, particleSpeed: 0.18 + (ei % 5) * 0.04 });
    });

    // ── Raycasting for hover / click ────────────────────────────────
    const raycaster = new THREE.Raycaster();
    const pointerNDC = new THREE.Vector2();
    let hovered = null;

    function pickNode(clientX, clientY) {
      const rect = renderer.domElement.getBoundingClientRect();
      pointerNDC.x = ((clientX - rect.left) / rect.width) * 2 - 1;
      pointerNDC.y = -((clientY - rect.top) / rect.height) * 2 + 1;
      raycaster.setFromCamera(pointerNDC, camera);
      const intersects = raycaster.intersectObjects(nodeMeshes.map((n) => n.mesh));
      return intersects.length ? nodeMeshes.find((n) => n.mesh === intersects[0].object) : null;
    }

    function onPointerMove(e) {
      const hit = pickNode(e.clientX, e.clientY);
      renderer.domElement.style.cursor = hit && onNodeClick ? 'pointer' : 'grab';
      if (hit !== hovered) {
        hovered = hit;
      }
      if (hit) {
        const screenPos = hit.mesh.position.clone().project(camera);
        const rect = renderer.domElement.getBoundingClientRect();
        setTooltip({
          node: hit.node,
          x: ((screenPos.x + 1) / 2) * rect.width,
          y: ((1 - screenPos.y) / 2) * rect.height,
        });
      } else {
        setTooltip(null);
      }
    }

    function onClick(e) {
      const hit = pickNode(e.clientX, e.clientY);
      if (hit && onNodeClick) onNodeClick(hit.node);
    }

    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('click', onClick);
    renderer.domElement.addEventListener('pointerleave', () => setTooltip(null));

    // ── Resize handling ─────────────────────────────────────────────
    function onResize() {
      const w = mount.clientWidth;
      const h = mount.clientHeight;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
    }
    const resizeObserver = new ResizeObserver(onResize);
    resizeObserver.observe(mount);

    // ── Animation loop ──────────────────────────────────────────────
    const clock = new THREE.Clock();
    let rafId;

    function animate() {
      rafId = requestAnimationFrame(animate);
      const elapsed = clock.getElapsedTime();
      controls.update();

      nodeMeshes.forEach((nm) => {
        const popT = THREE.MathUtils.clamp((elapsed - nm.popDelay) / 0.5, 0, 1);
        const eased = 1 - Math.pow(1 - popT, 3);
        nm.mesh.scale.setScalar(eased);
        nm.glow.material.opacity = 0.5 * eased * (0.85 + 0.15 * Math.sin(elapsed * nm.flickerSpeed + nm.phase));
        nm.mesh.material.emissiveIntensity = 0.55 * (0.86 + 0.14 * Math.sin(elapsed * nm.flickerSpeed + nm.phase));
        nm.label.material.opacity = eased;
        nm.mesh.rotation.y += 0.0015;
        nm.mesh.rotation.x += 0.0008;

        const isSelected = selectedIdRef.current === nm.node.id;
        nm.ring.visible = isSelected && eased > 0.5;
        if (nm.ring.visible) {
          const pulse = (elapsed * 0.6) % 1;
          nm.ring.scale.setScalar(1 + pulse * 0.4);
          nm.ring.material.opacity = 0.7 * (1 - pulse);
          nm.ring.lookAt(camera.position);
        }
      });

      edgeLines.forEach((el) => {
        const t = THREE.MathUtils.clamp((elapsed - el.drawDelay) / 0.6, 0, 1);
        el.material.opacity = 0.4 * t;
        if (el.particle) {
          el.particle.material.opacity = 0.9 * t;
          const u = (elapsed * el.particleSpeed) % 1;
          el.particle.position.copy(el.curve.getPoint(u));
        }
      });

      renderer.render(scene, camera);
    }

    const selectedIdRef = { current: selectedNodeId };
    stateRef.current.setSelected = (id) => { selectedIdRef.current = id; };

    animate();

    stateRef.current.cleanup = () => {
      cancelAnimationFrame(rafId);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('click', onClick);
      controls.dispose();
      renderer.dispose();
      scene.traverse((obj) => {
        if (obj.geometry) obj.geometry.dispose();
        if (obj.material) {
          if (Array.isArray(obj.material)) obj.material.forEach((m) => m.dispose());
          else obj.material.dispose();
        }
      });
      if (mount.contains(renderer.domElement)) mount.removeChild(renderer.domElement);
    };

    return () => stateRef.current.cleanup && stateRef.current.cleanup();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, onNodeClick]);

  // Keep the selection ring in sync without re-running the whole effect
  useEffect(() => {
    if (stateRef.current.setSelected) stateRef.current.setSelected(selectedNodeId);
  }, [selectedNodeId]);

  if (!nodes.length) return null;

  return (
    <div style={{ position: 'relative', width: '100%' }}>
      <div
        ref={mountRef}
        style={{ width: '100%', height: 560, borderRadius: 18, overflow: 'hidden', cursor: 'grab' }}
        aria-label="Mental model brain diagram (3D, drag to rotate, scroll to zoom)"
      />

      {tooltip && (
        <div
          style={{
            position: 'absolute',
            left: tooltip.x,
            top: tooltip.y,
            transform: 'translate(-50%, -122%)',
            background: 'rgba(18,19,25,0.96)',
            color: '#EAEAEF',
            borderRadius: 10,
            padding: '11px 15px',
            maxWidth: 230,
            fontSize: 12.5,
            lineHeight: 1.5,
            pointerEvents: 'none',
            zIndex: 10,
            boxShadow: '0 10px 28px rgba(0,0,0,0.45)',
            border: '1px solid rgba(255,255,255,0.08)',
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 4, fontSize: 13 }}>{tooltip.node.label}</div>
          <div style={{ opacity: 0.6, fontSize: 11, marginBottom: 5, textTransform: 'uppercase', letterSpacing: '0.05em' }}>
            {tooltip.node.type} · weight {tooltip.node.weight}/10
          </div>
          <div>{tooltip.node.description}</div>
        </div>
      )}

      <p style={{ margin: '12px 0 0', fontSize: 12, color: '#8A9298', textAlign: 'center' }}>
        Drag to rotate, scroll to zoom, click a node to open it.
      </p>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 16px', marginTop: 16, paddingTop: 16, borderTop: '1px solid #EFEBE2' }}>
        {Object.entries(NODE_TYPE_COLORS).map(([type, colors]) => (
          <div key={type} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#5B6B73' }}>
            <div style={{ width: 10, height: 10, borderRadius: '50%', background: colors.glow, border: `1.5px solid ${colors.stroke}` }} />
            <span style={{ textTransform: 'capitalize' }}>{type}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function makeRadialGlowTexture(hexColor) {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  const gradient = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  gradient.addColorStop(0, 'rgba(255,255,255,0.9)');
  gradient.addColorStop(0.4, 'rgba(255,255,255,0.35)');
  gradient.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}