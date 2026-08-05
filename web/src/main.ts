import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import {
  makeMask,
  buildExtrudedModel,
  type BuildResult,
} from './core/pipeline';
import { factoryTS, exportGLB, downloadText } from './core/exporter';

// ---------- DOM ----------
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const dropzone = $('dropzone');
const fileInput = $<HTMLInputElement>('fileInput');
const genBtn = $<HTMLButtonElement>('genBtn');
const view = $('view');
const placeholder = $('placeholder');
const thumbWrap = $('thumbWrap');
const thumb = $<HTMLImageElement>('thumb');
const fileName = $('fileName');
const stageList = $('stageList');
const info = $('info');
const flipBtn = $<HTMLButtonElement>('flipBtn');
const resetBtn = $<HTMLButtonElement>('resetBtn');
const downloadTS = $<HTMLButtonElement>('downloadTS');
const downloadGLB = $<HTMLButtonElement>('downloadGLB');

// ---------- State ----------
let sceneAPI: ReturnType<typeof initScene> | null = null;
let current: { result: BuildResult; dataURL: string; name: string } | null = null;
let pendingFile: File | null = null;
let flipY = true;

// ---------- Scene ----------
function initScene() {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(view.clientWidth, view.clientHeight);
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.05;
  view.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0d1117);

  const camera = new THREE.PerspectiveCamera(45, view.clientWidth / view.clientHeight, 0.1, 100);

  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.autoRotate = true;
  controls.autoRotateSpeed = 1.4;

  // Environment for PBR reflections
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;

  // Lights
  const hemi = new THREE.HemisphereLight(0xffffff, 0x202830, 0.6);
  scene.add(hemi);
  const dir = new THREE.DirectionalLight(0xffffff, 2.2);
  dir.position.set(4, 6, 5);
  dir.castShadow = true;
  dir.shadow.mapSize.set(1024, 1024);
  dir.shadow.camera.near = 0.5;
  dir.shadow.camera.far = 30;
  dir.shadow.camera.left = -6;
  dir.shadow.camera.right = 6;
  dir.shadow.camera.top = 6;
  dir.shadow.camera.bottom = -6;
  scene.add(dir);

  // Ground shadow catcher
  const ground = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 40),
    new THREE.ShadowMaterial({ opacity: 0.35 })
  );
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -1.4;
  ground.receiveShadow = true;
  scene.add(ground);

  const modelGroup = new THREE.Group();
  scene.add(modelGroup);

  function resize() {
    const w = view.clientWidth, h = view.clientHeight;
    renderer.setSize(w, h);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', resize);

  function frame(obj: THREE.Object3D) {
    const box = new THREE.Box3().setFromObject(obj);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const maxDim = Math.max(size.x, size.y, size.z) || 2;
    const dist = maxDim * 2.2;
    modelGroup.position.sub(center); // center the model at origin
    camera.position.set(dist * 0.7, dist * 0.4, dist * 0.9);
    controls.target.set(0, 0, 0);
    controls.update();
    ground.position.y = -maxDim * 0.6;
  }

  function animate() {
    requestAnimationFrame(animate);
    controls.update();
    renderer.render(scene, camera);
  }
  animate();

  return { scene, camera, controls, renderer, modelGroup, frame };
}

// ---------- Stages UI ----------
function setStage(name: string) {
  const items = stageList.querySelectorAll('li');
  let reached = false;
  items.forEach((li) => {
    const s = li.getAttribute('data-stage')!;
    li.classList.remove('active', 'done');
    if (s === name) { reached = true; li.classList.add('active'); }
    else if (!reached) li.classList.add('done');
  });
}

// ---------- Image processing ----------
function loadImage(file: File): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

async function processImage(file: File) {
  if (!sceneAPI) sceneAPI = initScene();
  setStage('load');
  const img = await loadImage(file);

  // draw to offscreen canvas (downscaled for speed)
  const maxDim = 240;
  const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
  const cw = Math.max(1, Math.round(img.width * scale));
  const ch = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = cw; canvas.height = ch;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, cw, ch);
  const data = ctx.getImageData(0, 0, cw, ch).data;

  setStage('mask');
  await raf();
  const mask = makeMask(data, cw, ch);

  setStage('geo');
  await raf();
  const result = buildExtrudedModel(mask, canvas);
  if (!result) {
    alert('未能从图片中识别出物体，请换一张背景更干净、主体更清晰的图片。');
    setStage('load');
    return;
  }

  setStage('mat');
  await raf();
  // swap model
  sceneAPI.modelGroup.clear();
  sceneAPI.modelGroup.add(result.mesh);
  sceneAPI.frame(result.mesh);

  const dataURL = canvas.toDataURL('image/png');
  current = { result, dataURL, name: file.name.replace(/\.[^.]+$/, '') };

  setStage('done');
  showInfo(mask, result);

  // enable controls
  flipBtn.disabled = false;
  resetBtn.disabled = false;
  downloadTS.disabled = false;
  downloadGLB.disabled = false;
  genBtn.disabled = true;
}

function showInfo(mask: ReturnType<typeof makeMask>, result: BuildResult) {
  const [r, g, b] = mask.avgColor;
  info.classList.remove('hidden');
  info.innerHTML =
    `<b>平均色</b> rgb(${r}, ${g}, ${b})<br>` +
    `<b>粗糙度</b> ${mask.roughness.toFixed(2)}<br>` +
    `<b>顶点数</b> ${result.info.vertices.toLocaleString()}<br>` +
    `<b>厚度</b> ${result.info.depth.toFixed(2)}`;
}

function raf() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()));
}

// ---------- Events ----------
dropzone.addEventListener('click', () => fileInput.click());
dropzone.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') fileInput.click(); });
dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('drag'); });
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('drag'));
dropzone.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('drag');
  const f = e.dataTransfer?.files?.[0];
  if (f && f.type.startsWith('image/')) selectFile(f);
});

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) selectFile(f);
});

function selectFile(file: File) {
  pendingFile = file;
  thumb.src = URL.createObjectURL(file);
  thumbWrap.classList.remove('hidden');
  fileName.textContent = file.name;
  placeholder?.classList.add('hidden');
  genBtn.disabled = false;
}

genBtn.addEventListener('click', () => {
  if (pendingFile) processImage(pendingFile);
});

flipBtn.addEventListener('click', () => {
  if (!current?.result.texture) return;
  flipY = !flipY;
  current.result.texture.flipY = flipY;
  current.result.texture.needsUpdate = true;
});

resetBtn.addEventListener('click', () => {
  if (sceneAPI) sceneAPI.modelGroup.clear();
  current = null;
  pendingFile = null;
  fileInput.value = '';
  thumbWrap.classList.add('hidden');
  info.classList.add('hidden');
  placeholder?.classList.remove('hidden');
  genBtn.disabled = true;
  flipBtn.disabled = true;
  resetBtn.disabled = true;
  downloadTS.disabled = true;
  downloadGLB.disabled = true;
  stageList.querySelectorAll('li').forEach((li) => li.classList.remove('active', 'done'));
});

downloadTS.addEventListener('click', () => {
  if (!current) return;
  const code = factoryTS({
    dataURL: current.dataURL,
    avgColor: current.result.info.avgColor,
    roughness: current.result.info.roughness,
    depth: current.result.info.depth,
  });
  downloadText(code, `${current.name || 'model'}.ts`, 'text/plain');
});

downloadGLB.addEventListener('click', () => {
  if (!current) return;
  exportGLB(current.result.mesh, `${current.name || 'model'}.glb`);
});
