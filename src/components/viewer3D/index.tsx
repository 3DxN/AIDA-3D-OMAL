import { useState, useEffect, useRef } from 'react'

import * as THREE from 'three'
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three'

import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader'

import * as checkPointInPolygon from 'robust-point-in-polygon'

// Controls
import Settings from './settings'
import Toolbar from './toolbar'

// Utils
import { padToTwo, resizeRendererToDisplaySize } from './utils'

type AxisName = 'x' | 'y' | 'z'

const axisNames: AxisName[] = ['x', 'y', 'z']

const cleanMaterial = (material: THREE.Material) => {
	material.dispose()

	// dispose textures
	for (const key of Object.keys(material)) {
		const value = material[key]
		if (value && typeof value === 'object' && 'minFilter' in value) {
			value.dispose()
		}
	}
}

const createAxisRow = (axis: AxisName, sign = 1) => {
	switch (axis) {
		case 'x':
			return [sign, 0, 0, 0]
		case 'y':
			return [0, sign, 0, 0]
		default:
			return [0, 0, sign, 0]
	}
}

const axisVector = (axis: AxisName) => {
	switch (axis) {
		case 'x':
			return new THREE.Vector3(1, 0, 0)
		case 'y':
			return new THREE.Vector3(0, 1, 0)
		default:
			return new THREE.Vector3(0, 0, 1)
	}
}

const alignContentToLayout = (object: THREE.Object3D) => {
	const originalBox = new THREE.Box3().setFromObject(object)
	const size = originalBox.getSize(new THREE.Vector3())
	const depthAxis = axisNames.reduce((smallestAxis, axis) =>
		size[axis] < size[smallestAxis] ? axis : smallestAxis
	)
	const horizontalAxis: AxisName = depthAxis === 'x' ? 'z' : 'x'
	const verticalAxis =
		axisNames.find(
			(axis) => axis !== depthAxis && axis !== horizontalAxis
		) ?? 'y'
	const depthSign =
		axisVector(depthAxis).cross(axisVector(verticalAxis)).dot(axisVector(horizontalAxis)) >
		0
			? 1
			: -1

	// Canonicalise the tile so depth runs along x and the 2D tile plane is z/y.
	const alignmentMatrix = new THREE.Matrix4().set(
		...createAxisRow(depthAxis, depthSign),
		...createAxisRow(verticalAxis, -1),
		...createAxisRow(horizontalAxis),
		0,
		0,
		0,
		1
	)

	object.applyMatrix4(alignmentMatrix)
	object.updateMatrixWorld(true)

	const alignedBox = new THREE.Box3().setFromObject(object)
	object.position.sub(alignedBox.min)
	object.updateMatrixWorld(true)

	return new THREE.Box3().setFromObject(object)
}

const Viewer3D = (props: {
	tile: [number, number]
	tilesUrl: string
	fileNamePattern3D: any
	polygonCoords: number[][][]
	setSelect3D: (select3D: boolean) => void
}) => {
	const { tile, tilesUrl, fileNamePattern3D, polygonCoords, setSelect3D } = props

	const [content, setContent] = useState(null)
	const [scene, setScene] = useState<Scene | undefined>(undefined)
	const [camera, setCamera] = useState<PerspectiveCamera | undefined>(undefined)
	const [renderer, setRenderer] = useState<WebGLRenderer | undefined>(undefined)
	const [isLoading, setIsLoading] = useState(false)
	const [featureData, setFeatureData] = useState(null)
	const [open, setOpen] = useState(false)
	// Array of selected nuclei as specified by polygon on 2D viewer
	const [selected, setSelected] = useState([])
	const selectedCache = useRef([])

	// Reference to viewer element
	const viewerRef: { current: HTMLCanvasElement | null } = useRef(null)

	// Init
	useEffect(() => {
		if (viewerRef.current) {
			// Rendering 3D tile.
			const canvas = viewerRef.current
			const newRenderer = new THREE.WebGLRenderer({
				antialias: true,
				canvas: canvas,
			})
			newRenderer.setPixelRatio(window.devicePixelRatio)
			// newRenderer.setSize(container.clientWidth, container.clientHeight)
			newRenderer.toneMapping = THREE.ACESFilmicToneMapping
			newRenderer.toneMappingExposure = 1
			newRenderer.outputEncoding = THREE.sRGBEncoding
			setRenderer(newRenderer)

			const newCamera = new THREE.PerspectiveCamera(
				45,
				canvas.clientWidth / canvas.clientHeight,
				0.25,
				20
			)
			setCamera(newCamera)

			const environment = new RoomEnvironment()
			const pmremGenerator = new THREE.PMREMGenerator(newRenderer)

			const newScene = new THREE.Scene()
			newScene.background = new THREE.Color('#f3f4f6')
			newScene.environment = pmremGenerator.fromScene(environment).texture
			setScene(newScene)

			// Lights
			// This soft white light globally illuminates all objects in the scene equally.
			const light = new THREE.AmbientLight(0x505050)
			newScene.add(light)

			newCamera.aspect = canvas.clientWidth / canvas.clientHeight
			newCamera.updateProjectionMatrix()

			resizeRendererToDisplaySize(newRenderer)
			window.addEventListener('resize', () =>
				resizeRendererToDisplaySize(newRenderer)
			)
		}
	}, [])

	// Update tile
	useEffect(() => {
		if (tile) {
			// Activate visual loading indicator
			setIsLoading(true)

			// model
			const H = padToTwo(tile[0])
			const V = padToTwo(tile[1])
			const newLoader = new GLTFLoader()

			function compileTemplate(template:string) { return new Function("data", "return `" + template + "`;"); }

			const templateUrl = fileNamePattern3D.meshFile??"${data.tilesUrl}/tile__H0${data.H}_V0${data.V}.tif__.gltf"
			const renderMeshUrlTemplate = compileTemplate(templateUrl)
			const url = renderMeshUrlTemplate({tilesUrl: tilesUrl, "H": H, "V": V })
			console.log("URL for 3D mesh data: " + url)

			if (scene) {
				scene.clear()

				// Also need to clear the objects from memory to avoid leak.
				scene.traverse((object) => {
					if (!object.isMesh) return
					object.geometry.dispose()

					if (object.material.isMaterial) {
						cleanMaterial(object.material)
					} else {
						// an array of materials
						for (const material of object.material) cleanMaterial(material)
					}
				})
			}

			newLoader.load(url, (gltf) => {
				// Deactivate loading indicator
				setIsLoading(false)

				const newContent = gltf.scene

				// Normalise the tile orientation so the 3D view and the 2D tile
				// layout use the same in-tile plane across datasets.
				const box = alignContentToLayout(newContent)
				scene.add(newContent)
				setContent(newContent)

				// The legacy viewer used per-tile manual rotations here. Alignment is
				// now handled once by alignContentToLayout above.

				// Setup the space for the new object
				// This is from three-gltf-viewer
				const size = box.getSize(new THREE.Vector3()).length()
				const center = box.getCenter(new THREE.Vector3())
				const midY = (box.max.y - box.min.y) / 2
				const midZ = (box.max.z - box.min.z) / 2

				camera.near = size / 100
				camera.far = size * 100

				const cameraDistance = size * 1.5
				const cameraPos = scene.localToWorld(
					new THREE.Vector3(center.x - cameraDistance, midY, midZ)
				)
				camera.position.copy(cameraPos)
				camera.lookAt(center)
				camera.updateProjectionMatrix()

				// Axes helper
				const axesHelper = new THREE.AxesHelper(1000)
				scene.add(axesHelper)

				renderer.render(scene, camera)
			})
		}
	}, [tile, camera, scene, renderer, tilesUrl, fileNamePattern3D?.meshFile])

	// Update feature data
	useEffect(() => {
		if (tile) {
			const H = padToTwo(tile[0])
			const V = padToTwo(tile[1])

			function compileTemplate(template:string) { return new Function("data", "return `" + template + "`;"); }

			const templateUrl = fileNamePattern3D.featureFile??"${data.ilesUrl}/tile__H0${data.H}_V0${data.V}.tif__.json"
			const renderFeaturesUrlTemplate = compileTemplate(templateUrl)
			const url = renderFeaturesUrlTemplate({tilesUrl: tilesUrl, "H": H, "V": V })
			console.log("URL for 3D feature/attribute data: " + url)

			fetch(url).then((featureDataFile) => {
				featureDataFile.json().then((data) => setFeatureData(data))
			})
		}
	}, [tile, tilesUrl, fileNamePattern3D?.featureFile])

	// Adjust selections from the 2D viewer
	// When new polygon coords are provided we project nuclei into the aligned
	// in-tile layout plane and select those whose centers fall inside the polygon.
	useEffect(() => {
		// Reset any previous selection
		setSelected([])

		if (polygonCoords && polygonCoords.length > 0 && content && renderer) {
			const selectedNuclei = []
			const contentBox = new THREE.Box3().setFromObject(content)

			// Check if nuclei is inside polygon, if yes, set as selected
			content.children.forEach((child, index) => {
				if (child.isMesh && child.name.includes('nucleus')) {
					let match = true
					const nucleus = child

					// Get the nucleus bounding sphere in world coords
					if (nucleus.geometry.boundingSphere === null)
						nucleus.geometry.computeBoundingSphere()
					const sphere = nucleus.geometry.boundingSphere.clone()
					nucleus.localToWorld(sphere.center)
					const center = sphere.center
					const layoutPoint = [
						center.z - contentBox.min.z,
						center.y - contentBox.min.y,
					]

					// Exclude the nucleus if its center point is outside the polygon
					if (checkPointInPolygon(polygonCoords, layoutPoint) > 0) {
						match = false
					}

					// Exclude the nucleus if its center point is outside the clipping
					// planes but include if it's bounding sphere intersects the clipping
					// planes (this is to make sure all visible meshes can be
					// selected). Points in space whose dot product with the plane is
					// negative are cut away.
					renderer.clippingPlanes.forEach((plane) => {
						const dot = center.dot(plane.normal) + plane.constant < 0
						const intersects = sphere.intersectsPlane(plane)
						if (dot && !intersects) match = false
					})

					// Exclude if not visible
					if (!nucleus.visible) match = false

					if (match) selectedNuclei.push(nucleus)
				}
			})

			setSelected(selectedNuclei)
		}
	}, [polygonCoords, content, renderer])

	// Render selections
	useEffect(() => {
		if (renderer && scene && camera) {
			// Remove highlights from previous selection and reset cache
			selectedCache.current.forEach((nucleus) =>
				nucleus.material.emissive.set(0x000000)
			)
			selectedCache.current = selected

			// Highlight current selection
			selected.forEach((nucleus) => nucleus.material.emissive.set(0xffffff))

			renderer.render(scene, camera)
		}
	}, [selected, renderer, scene, camera])

	return (
		<div className="min-w-full h-screen flex border-l border-l-teal-500">
			<div className="flex-grow flex items-center justify-center bg-blue-500">
				{!tile && (
					<div className="absolute">
						Select a 2D tile to show the corresponding 3D segmentation
					</div>
				)}

				{isLoading && (
					<div className="absolute">
						<svg
							className="animate-spin h-5 w-5 text-teal-800"
							fill="none"
							viewBox="0 0 24 24"
						>
							<circle
								className="opacity-25"
								cx="12"
								cy="12"
								r="10"
								stroke="currentColor"
								strokeWidth="4"
							/>
							<path
								className="opacity-75"
								fill="currentColor"
								d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
							/>
						</svg>
					</div>
				)}

				<canvas className="w-full h-full" ref={viewerRef} />
			</div>

			{tile && (
				<Toolbar
					camera={camera}
					scene={scene}
					renderer={renderer}
					content={content}
					setSelected={setSelected}
					setSelect3D={setSelect3D}
				/>
			)}

			<Settings
				renderer={renderer}
				scene={scene}
				camera={camera}
				content={content}
				tile={tile}
				featureData={featureData}
				selected={selected}
			/>
		</div>
	)
}

export default Viewer3D
