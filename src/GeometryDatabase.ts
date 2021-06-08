import * as THREE from 'three';
import c3d from '../build/Release/c3d.node';
import { EditorSignals } from './Editor';
import { Clone, GeometryMemento } from './History';
import MaterialDatabase from './MaterialDatabase';
import { assertUnreachable } from './util/Util';
import * as visual from './VisualModel';

const precision_distance: [number, number][] = [[0.1, 50], [0.001, 5], [0.0001, 0.5]];

export interface TemporaryObject {
    cancel(): void;
    commit(): Promise<visual.SpaceItem>;
}

let counter = 0;

export class GeometryDatabase {
    readonly drawModel = new Set<visual.SpaceItem>();
    readonly scene = new THREE.Scene();
    private readonly geometryModel = new Map<number, c3d.Item>();

    constructor(
        private readonly materials: MaterialDatabase,
        private readonly signals: EditorSignals) { }

    async addItem(model: c3d.Item): Promise<visual.SpaceItem> {
        const current = counter++;
        this.geometryModel.set(current, model);

        const visual = await this.meshes(model, precision_distance);
        visual.userData.simpleName = current;

        this.scene.add(visual);
        this.drawModel.add(visual);

        this.signals.objectAdded.dispatch(visual);
        this.signals.sceneGraphChanged.dispatch();
        return visual;
    }

    async addTemporaryItem(object: c3d.Item): Promise<TemporaryObject> {
        const mesh = await this.meshes(object, [[0.005, 1]]);
        this.scene.add(mesh);
        const that = this;
        return {
            cancel() {
                mesh.dispose();
                that.scene.remove(mesh);
            },
            commit() {
                that.scene.remove(mesh);
                return that.addItem(object);
            }
        }
    }

    removeItem(object: visual.Item) {
        this.scene.remove(object);
        this.drawModel.delete(object);
        this.geometryModel.delete(object.userData.simpleName);

        this.signals.objectRemoved.dispatch(object);
        this.signals.sceneGraphChanged.dispatch();
    }

    private lookupItem(object: visual.Item): c3d.Item {
        const simpleName = object.userData.simpleName;
        if (!this.geometryModel.has(simpleName)) throw new Error(`invalid precondition: object ${simpleName} missing from geometry model`);

        const item = this.geometryModel.get(object.userData.simpleName);
        return item!;
    }

    // FIXME rethink error messages and consider using Family rather than isA for curve3d?
    lookup(object: visual.Solid): c3d.Solid;
    lookup(object: visual.SpaceInstance<any>): c3d.SpaceInstance;
    lookup(object: visual.PlaneInstance<any>): c3d.PlaneInstance;
    lookup(object: visual.Item): c3d.Item;
    lookup(object: visual.Item): c3d.Item {
        const item = this.lookupItem(object);
        return item;
    }

    lookupTopologyItem(object: visual.Face): c3d.Face;
    lookupTopologyItem(object: visual.Edge): c3d.Edge;
    lookupTopologyItem(object: visual.Edge | visual.Face): c3d.TopologyItem {
        const parent = object.parentItem;
        const parentModel = this.lookupItem(parent);
        if (!(parentModel instanceof c3d.Solid)) throw new Error("Invalid precondition");
        const solid = parentModel;

        if (object instanceof visual.Edge) {
            const result = solid.FindEdgeByName(object.userData.name);
            if (!result) throw new Error("cannot find edge");
            return result;
        } else if (object instanceof visual.Face) {
            const result = solid.FindFaceByName(object.userData.name);
            if (!result) throw new Error("cannot find face");
            return result;
        }
        assertUnreachable(object);
    }

    find<T extends visual.Item>(klass: any): T[] {
        const result: T[] = [];
        for (const item of this.drawModel.values()) {
            if (item instanceof klass) {
                // @ts-expect-error
                result.push(item);
            }
        }
        return result;
    }

    private async meshes(obj: c3d.Item, precision_distance: [number, number][]): Promise<visual.Item> {
        let builder;
        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance:
                builder = new visual.SpaceInstanceBuilder();
                break;
            case c3d.SpaceType.PlaneInstance:
                builder = new visual.PlaneInstanceBuilder();
                break;
            case c3d.SpaceType.Solid:
                builder = new visual.SolidBuilder();
                break;
            default:
                throw new Error("type not yet supported");
        }

        for (const [precision, distance] of precision_distance) {
            await this.object2mesh(builder, obj, precision, distance);
        }

        const result = builder.build();
        return result;
    }

    private async object2mesh(builder: any, obj: c3d.Item, sag: number, distance?: number): Promise<void> {
        const stepData = new c3d.StepData(c3d.StepType.SpaceStep, sag);
        const note = new c3d.FormNote(true, true, true, false, false);
        const item = await obj.CreateMesh_async(stepData, note);
        const mesh = item.Cast<c3d.Mesh>(c3d.SpaceType.Mesh);
        switch (obj.IsA()) {
            case c3d.SpaceType.SpaceInstance: {
                const instance = builder as visual.SpaceInstanceBuilder<visual.Curve3D>;
                const curve3D = new visual.Curve3DBuilder();
                const edges = mesh.GetEdges();
                let material = this.materials.line(obj as c3d.SpaceInstance);
                for (const edge of edges) {
                    const line = visual.CurveSegment.build(edge, material);
                    curve3D.addCurveSegment(line);
                }
                instance.addLOD(curve3D.build(), distance);
                break;
            }
            case c3d.SpaceType.PlaneInstance: {
                const instance = builder as visual.PlaneInstanceBuilder<visual.Region>;
                const grids = mesh.GetBuffers();
                if (grids.length != 1) throw new Error("Invalid precondition");
                const grid = grids[0];
                const material = this.materials.region();
                const region = visual.Region.build(grid, material);
                instance.addLOD(region, distance);
                break;
            }
            // case c3d.SpaceType.Point3D: {
            //     const apexes = mesh.GetApexes();
            //     const geometry = new THREE.BufferGeometry();
            //     geometry.setAttribute('position', new THREE.Float32BufferAttribute(apexes, 3));
            //     const points = new THREE.Points(geometry, this.materials.point(obj));
            //     return points;
            // }
            case c3d.SpaceType.Solid: {
                const solid = builder as visual.SolidBuilder;
                const edges = new visual.CurveEdgeGroupBuilder();
                const lineMaterial = this.materials.line();
                const polygons = mesh.GetEdges(true);
                for (const edge of polygons) {
                    const line = visual.CurveEdge.build(edge, lineMaterial, this.materials.lineDashed());
                    edges.addEdge(line);
                }

                const faces = new visual.FaceGroupBuilder();
                const grids = mesh.GetBuffers();
                for (const grid of grids) {
                    const material = this.materials.mesh(grid, mesh.IsClosed());
                    const face = visual.Face.build(grid, material);
                    faces.addFace(face);
                }
                solid.addLOD(edges.build(), faces.build(), distance);
                break;
            }
            default: {
                throw new Error("type not yet supported");
            }
        }
    }

    saveToMemento(registry: Map<any, any>): GeometryMemento {
        return new GeometryMemento(
            Clone(this.drawModel, registry),
            Clone(this.geometryModel, registry),
            Clone(this.scene, registry));
    }

    restoreFromMemento(m: GeometryMemento) {
        // .drawModel and .scene are both public; it's best to modify in place
        // in case anyone has references to them. currently, we do this just for drawModel.

        this.drawModel.clear();
        for (const v of m.drawModel) this.drawModel.add(v);

        (this.scene as GeometryDatabase['scene']) = m.scene;
        (this.geometryModel as GeometryDatabase['geometryModel']) = m.geometryModel;
    }
}