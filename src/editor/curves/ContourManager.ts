import c3d from '../../../build/Release/c3d.node';
import { DatabaseProxy } from '../DatabaseProxy';
import { GeometryDatabase } from '../GeometryDatabase';
import * as visual from "../../visual_model/VisualModel";
import { PlanarCurveDatabase } from './PlanarCurveDatabase';
import { RegionManager } from "./RegionManager";
import { Agent } from '../DatabaseLike';

/**
 * The ContourManager is a DatabaseProxy that observes inserts/deletes/replaces of curves. When the curves change in the system
 * it notifies the PlanarCurveDatabase (which is responsible for trimming planar curves at intersections) as well as the
 * RegionManager (which is responsible for taking planar curves and turning them into regions).
 * 
 * In general, methods of this class MUST to be called with the transaction() wrapper, otherwise race conditions related
 * to asynchronous code will cause things to explode.
 * 
 * The transaction wrapper aggregates adds/deletes so that all of the work can be processed at once. It makes code more
 * efficient, of course. But equally importantly, you have to worry about cases where removing one curve "dirties" the
 * intersections of another curve, and if that curve is also deleted in parallel, everything goes wrong.
 */

export class CurveInfo {
    readonly touched = new Set<c3d.SimpleName>();
    fragments = new Array<Promise<c3d.SimpleName>>();
    readonly joints = new Joints();
    constructor(readonly planarCurve: c3d.SimpleName, readonly placement: c3d.Placement3D) { }
}

export type Curve2dId = bigint;
export type Trim = { trimmed: c3d.Curve, start: number, stop: number };
export type Transaction = { dirty: CurveSet, added: CurveSet, deleted: CurveSet }
type CurveSet = Set<c3d.SimpleName>;
type State = { tag: 'none' } | { tag: 'transaction', transaction: Transaction }

export default class ContourManager extends DatabaseProxy {
    private state: State = { tag: 'none' };

    constructor(
        db: GeometryDatabase,
        private readonly curves: PlanarCurveDatabase,
        private readonly regions: RegionManager,
    ) {
        super(db);
    }

    async hide(item: visual.Item) {
        const result = await this.db.hide(item);
        if (item instanceof visual.SpaceInstance) {
            await this.removeCurve(item);
        }
        return result;
    }

    async unhide(item: visual.Item) {
        const result = await this.db.unhide(item);
        if (item instanceof visual.SpaceInstance) {
            await this.addCurve(item);
        }
        return result;
    }

    async makeVisible(item: visual.Item, value: boolean): Promise<void> {
        const result = await this.db.makeVisible(item, value);
        if (item instanceof visual.SpaceInstance) {
            if (value) {
                await this.addCurve(item);
            } else {
                await this.removeCurve(item);
            }
        }
        return result;
    }

    // FIXME, this should be in a contour transaction
    async unhideAll(): Promise<visual.Item[]> {
        const unhidden = await this.db.unhideAll();
        const promises = [];
        for (const item of unhidden) {
            if (item instanceof visual.SpaceInstance) {
                promises.push(this.addCurve(item));
            }
        }
        await Promise.all(promises);
        return unhidden;
    }

    async addItem(model: c3d.Solid, agent?: Agent): Promise<visual.Solid>;
    async addItem(model: c3d.SpaceInstance, agent?: Agent): Promise<visual.SpaceInstance<visual.Curve3D>>;
    async addItem(model: c3d.PlaneInstance, agent?: Agent): Promise<visual.PlaneInstance<visual.Region>>;
    async addItem(model: c3d.Item, agent: Agent = 'user'): Promise<visual.Item> {
        const result = await this.db.addItem(model, agent);
        if (result instanceof visual.SpaceInstance) {
            await this.addCurve(result);
        }
        return result;
    }

    async replaceItem(from: visual.Solid, model: c3d.Solid, agent?: Agent): Promise<visual.Solid>;
    async replaceItem<T extends visual.SpaceItem>(from: visual.SpaceInstance<T>, model: c3d.SpaceInstance, agent?: Agent): Promise<visual.SpaceInstance<visual.Curve3D>>;
    async replaceItem<T extends visual.PlaneItem>(from: visual.PlaneInstance<T>, model: c3d.PlaneInstance, agent?: Agent): Promise<visual.PlaneInstance<visual.Region>>;
    async replaceItem(from: visual.Item, model: c3d.Item, agent?: Agent): Promise<visual.Item>;
    async replaceItem(from: visual.Item, to: c3d.Item): Promise<visual.Item> {
        const result = await this.db.replaceItem(from, to);
        if (from instanceof visual.SpaceInstance) {
            await this.removeCurve(from);
            await this.addCurve(result as visual.SpaceInstance<visual.Curve3D>);
        }
        return result;
    }

    async removeItem(view: visual.Item, agent?: Agent): Promise<void> {
        const result = await this.db.removeItem(view, agent);
        if (view instanceof visual.SpaceInstance) {
            await this.removeCurve(view);
        }
        return result;
    }

    async addCurve(curve: visual.SpaceInstance<visual.Curve3D>) {
        switch (this.state.tag) {
            case 'none':
                await this.curves.add(curve);
                const info = this.curves.lookup(curve);
                await this.regions.updatePlacement(info.placement);
                return;
            case 'transaction':
                this.state.transaction.added.add(curve.simpleName);
        }
    }

    async removeCurve(curve: visual.SpaceInstance<visual.Curve3D>) {
        switch (this.state.tag) {
            case 'none':
                const info = this.curves.lookup(curve);
                this.curves.remove(curve);
                await this.regions.updatePlacement(info.placement);
                break;
            case 'transaction':
                this.curves.cascade(curve, this.state.transaction);
        }
    }

    async transaction(f: () => Promise<void>) {
        switch (this.state.tag) {
            case 'none': {
                const transaction: Transaction = { dirty: new Set(), added: new Set(), deleted: new Set() };
                this.state = { tag: 'transaction', transaction: transaction };
                try {
                    await f();
                    const placements = new Set<c3d.Placement3D>();
                    this.placementsAffectedByTransaction(transaction.dirty, placements);
                    this.placementsAffectedByTransaction(transaction.deleted, placements);
                    await this.curves.commit(transaction);
                    this.placementsAffectedByTransaction(transaction.added, placements);
                    if (transaction.dirty.size > 0 || transaction.added.size > 0 || transaction.deleted.size > 0) {
                        for (const p of placements) await this.regions.updatePlacement(p);
                    }
                } finally {
                    this.state = { tag: 'none' };
                }
                return;
            }
            default: throw new Error("invalid state: " + this.state.tag);
        }
    }

    async rebuild() {
        const curves = this.db.find(visual.SpaceInstance);
        await this.transaction(async () => {
            for (const curve of curves) this.addCurve(curve.view);
        });
    }

    private placementsAffectedByTransaction(dirty: CurveSet, placements: Set<c3d.Placement3D>) {
        for (const c of dirty) {
            const info = this.curves.lookup(c);
            if (info !== undefined) placements.add(info.placement);
        }
    }
}

export class PointOnCurve {
    constructor(
        readonly id: c3d.SimpleName,
        readonly t: number,
        readonly tmin: number,
        readonly tmax: number
    ) { }

    get isTmin() { return this.t === this.tmin }
    get isTmax() { return this.t === this.tmax }
}

export class Joint {
    constructor(
        readonly on1: PointOnCurve,
        readonly on2: PointOnCurve
    ) { }
}

class Joints {
    constructor(public start?: Joint, public stop?: Joint) { }
}
