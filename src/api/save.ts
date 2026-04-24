// Packages
import Map from 'ol/Map'
import VectorLayer from 'ol/layer/Vector'
import VectorSource from 'ol/source/Vector'
import Geometry from 'ol/geom/Geometry'

import createSimpleId from '../lib/utils/createSimpleId'

// Types
import { Annotation } from '../types/annotation'
import type Point from 'ol/geom/Point'
import type LineString from 'ol/geom/LineString'
import type Polygon from 'ol/geom/Polygon'

type FeatureGeom = Point | LineString | Polygon

type SaveFilePickerHandle = {
	createWritable: () => Promise<{
		write: (data: string | Blob) => Promise<void>
		close: () => Promise<void>
	}>
}

type SaveFilePickerWindow = Window & {
	showSaveFilePicker?: (options?: {
		suggestedName?: string
		types?: Array<{
			description?: string
			accept: Record<string, string[]>
		}>
	}) => Promise<SaveFilePickerHandle>
}

// Initial default template for new annotation data
const defaultAnnotation: Annotation = {
	header: {
		schemaVersion: '2.0',
		timestamp: Date.now(),
	},
	layers: [],
	classes: [],
}

const isAbortError = (err: unknown) =>
	typeof err === 'object' &&
	err !== null &&
	'name' in err &&
	(err as { name?: string }).name === 'AbortError'

const getSuggestedAnnotationName = () => {
	const pathSegments = window.location.pathname.split('/').filter(Boolean)
	const lastSegment = pathSegments[pathSegments.length - 1] ?? 'annotations'
	const baseName = lastSegment.replace(/\.[^.]+$/, '') || 'annotations'
	const normalisedBaseName = /annotations?$/i.test(baseName)
		? baseName
		: `${baseName}-annotations`

	return `${normalisedBaseName}.json`
}

const triggerDownload = (json: string, suggestedName: string) => {
	const blob = new Blob([json], { type: 'application/json' })
	const downloadUrl = URL.createObjectURL(blob)
	const link = document.createElement('a')

	link.href = downloadUrl
	link.download = suggestedName
	link.style.display = 'none'
	document.body.appendChild(link)
	link.click()
	document.body.removeChild(link)

	window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 0)
}

const saveWithPicker = async (json: string, suggestedName: string) => {
	const pickerWindow = window as SaveFilePickerWindow

	if (!pickerWindow.showSaveFilePicker) {
		triggerDownload(json, suggestedName)
		return
	}

	const handle = await pickerWindow.showSaveFilePicker({
		suggestedName,
		types: [
			{
				description: 'JSON annotation',
				accept: {
					'application/json': ['.json'],
				},
			},
		],
	})
	const writable = await handle.createWritable()

	await writable.write(json)
	await writable.close()
}

// Save the annotation data
export const save = async (map: Map) => {
	const annotation: Annotation = {
		header: {
			...defaultAnnotation.header,
			timestamp: Date.now(),
		},
		layers: [],
		classes: [],
	}

	// Add feature classes
	const featureClasses = map.get('featureClasses')
	annotation.classes = Object.values(featureClasses)

	// Add layers
	const layers = map.getLayers()
	const annotationLayers = layers
		.getArray()
		.filter((layer) => layer.get('type') === 'annotation')

	annotation.layers = annotationLayers.map((layer) => {
		const features = (layer as VectorLayer<VectorSource<Geometry>>)
			.getSource()
			.getFeatures()

		// Extract features
		// TODO: fix type problems with the below when using Feature[]
		const layerFeatures: any[] = features.flatMap((feature) => {
			const geometry = feature.getGeometry()

			if (geometry) {
				const geometryType = geometry.getType()
				const geometryCoordinates = (geometry as FeatureGeom).getCoordinates()

				return {
					id: feature.get('id') || createSimpleId(),
					class: feature.get('class'),
					geometry: {
						type: geometryType,
						coordinates: geometryCoordinates,
					},
				}
			} else return []
		})

		return {
			id: layer.get('id'),
			features: layerFeatures,
		}
	})
	const json = JSON.stringify(annotation, null, 2)
	const suggestedName = getSuggestedAnnotationName()

	try {
		await saveWithPicker(json, suggestedName)
		map.set('unsavedChanges', false)
	} catch (err) {
		if (!isAbortError(err)) console.error(err)
	}
}
