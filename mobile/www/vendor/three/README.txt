three.js r170 (npm three@0.170.0, MIT) for the 3D model viewer in Project Files.
GLTFLoader, OrbitControls, BufferGeometryUtils and the meshopt decoder come from
examples/jsm; their `from 'three'` imports were changed to './three.module.min.js'
so the files load without an import map.
