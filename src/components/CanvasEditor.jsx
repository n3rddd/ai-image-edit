import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, Image as FabricImage, Path, PencilBrush, Rect } from 'fabric';
import { Eraser, MousePointer2, Pencil, Redo2, Square, Trash2, Undo2 } from 'lucide-react';
import { Button } from './ui/Button';

export function CanvasEditor({
    imageUrl,
    isDrawing,
    setIsDrawing,
    drawMode,
    setDrawMode,
    brushSize = 30,
    setBrushSize,
    onCanvasReady,
    onRegionsChange,
}) {
    const canvasRef = useRef(null);
    const containerRef = useRef(null);
    const [fabricCanvas, setFabricCanvas] = useState(null);

    const historyRef = useRef([]);
    const historyStepRef = useRef(-1);
    const [historyStep, setHistoryStep] = useState(-1);
    const [historyLength, setHistoryLength] = useState(0);
    const restoreTokenRef = useRef(0);
    const [isRestoring, setIsRestoring] = useState(false);

    const isRectDrawingRef = useRef(false);
    const rectStartPointRef = useRef(null);
    const currentRectRef = useRef(null);

    const pointerRafRef = useRef(0);
    const lastPointerRef = useRef(null);
    const [pointer, setPointer] = useState(null);
    const [zoom, setZoom] = useState(1);

    const imageInfoRef = useRef(null);
    const viewModeRef = useRef('fit'); // 'fit' | 'manual' | '1:1'

    const spacePressedRef = useRef(false);
    const isPanningRef = useRef(false);
    const lastPanClientRef = useRef(null);

    const rectInfoRafRef = useRef(0);
    const lastRectInfoRef = useRef(null);
    const [rectInfo, setRectInfo] = useState(null);

    const nextRegionIdRef = useRef(1);
    const imageLoadTokenRef = useRef(0);

    const handlersRef = useRef({
        mouseDown: null,
        mouseMove: null,
        mouseUp: null,
        pathCreated: null,
    });

    const setAllObjectsSelectable = (canvas, selectable) => {
        canvas.getObjects().forEach(obj => obj.set({ selectable, evented: selectable }));
    };

    const schedulePointerUpdate = (pt) => {
        lastPointerRef.current = pt;
        if (pointerRafRef.current) return;
        pointerRafRef.current = requestAnimationFrame(() => {
            pointerRafRef.current = 0;
            setPointer(lastPointerRef.current);
        });
    };

    const scheduleRectInfoUpdate = (info) => {
        lastRectInfoRef.current = info;
        if (rectInfoRafRef.current) return;
        rectInfoRafRef.current = requestAnimationFrame(() => {
            rectInfoRafRef.current = 0;
            setRectInfo(lastRectInfoRef.current);
        });
    };

    const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

    const clampPointToImage = (pt) => {
        const img = imageInfoRef.current;
        if (!img) return pt;
        return {
            x: clamp(pt.x, 0, img.width),
            y: clamp(pt.y, 0, img.height),
        };
    };

    const fitToView = () => {
        if (!fabricCanvas || !imageInfoRef.current) return;
        const { width: imgW, height: imgH } = imageInfoRef.current;
        const viewW = fabricCanvas.getWidth();
        const viewH = fabricCanvas.getHeight();
        if (!viewW || !viewH || !imgW || !imgH) return;

        const nextZoom = Math.min(1, Math.min(viewW / imgW, viewH / imgH));
        const tx = (viewW - imgW * nextZoom) / 2;
        const ty = (viewH - imgH * nextZoom) / 2;
        fabricCanvas.setViewportTransform([nextZoom, 0, 0, nextZoom, tx, ty]);
        fabricCanvas.requestRenderAll();
        fabricCanvas.calcOffset();
        setZoom(nextZoom);
        viewModeRef.current = 'fit';
    };

    const resetTo1to1 = () => {
        if (!fabricCanvas || !imageInfoRef.current) return;
        const { width: imgW, height: imgH } = imageInfoRef.current;
        const viewW = fabricCanvas.getWidth();
        const viewH = fabricCanvas.getHeight();
        const tx = imgW < viewW ? (viewW - imgW) / 2 : 0;
        const ty = imgH < viewH ? (viewH - imgH) / 2 : 0;
        fabricCanvas.setViewportTransform([1, 0, 0, 1, tx, ty]);
        fabricCanvas.requestRenderAll();
        fabricCanvas.calcOffset();
        setZoom(1);
        viewModeRef.current = '1:1';
    };

    const copyToClipboard = async (text) => {
        if (!text) return false;
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch {
            try {
                const el = document.createElement('textarea');
                el.value = text;
                el.style.position = 'fixed';
                el.style.left = '-9999px';
                document.body.appendChild(el);
                el.focus();
                el.select();
                const ok = document.execCommand('copy');
                document.body.removeChild(el);
                return ok;
            } catch {
                return false;
            }
        }
    };

    const snapshotObjects = (canvas) =>
        canvas.getObjects().map(obj => obj.toObject(['selectable', 'evented', 'regionId']));

    const syncRegions = () => {
        if (!fabricCanvas) return;
        const img = imageInfoRef.current;
        const imgW = img?.width ?? 0;
        const imgH = img?.height ?? 0;

        let maxId = 0;
        const regions = fabricCanvas
            .getObjects()
            .filter(obj => obj?.type === 'rect')
            .map((obj) => {
                if (!obj.regionId) {
                    obj.regionId = nextRegionIdRef.current++;
                }
                maxId = Math.max(maxId, obj.regionId);
                const bounds = obj.getBoundingRect();
                const x = clamp(bounds.left, 0, imgW);
                const y = clamp(bounds.top, 0, imgH);
                const width = clamp(bounds.width, 0, imgW - x);
                const height = clamp(bounds.height, 0, imgH - y);
                return { id: obj.regionId, x, y, width, height };
            })
            .sort((a, b) => a.id - b.id);

        if (maxId >= nextRegionIdRef.current) nextRegionIdRef.current = maxId + 1;
        onRegionsChange?.(regions);
    };

    const resetHistory = () => {
        historyRef.current = [[]];
        historyStepRef.current = 0;
        setHistoryLength(1);
        setHistoryStep(0);
    };

    const pushHistory = () => {
        if (!fabricCanvas) return;
        const snapshot = snapshotObjects(fabricCanvas);
        let next = historyRef.current.slice(0, historyStepRef.current + 1);
        next.push(snapshot);

        const MAX_HISTORY = 80;
        if (next.length > MAX_HISTORY) next = next.slice(next.length - MAX_HISTORY);

        historyRef.current = next;
        historyStepRef.current = next.length - 1;
        setHistoryLength(next.length);
        setHistoryStep(historyStepRef.current);
    };

    const fromObjectAsync = (klass, obj) => {
        try {
            const result = klass.fromObject(obj);
            if (result && typeof result.then === 'function') return result;
            return new Promise((resolve) => klass.fromObject(obj, resolve));
        } catch (err) {
            return Promise.reject(err);
        }
    };

    const restoreObjectsFromSnapshot = async (snapshot, selectable) => {
        if (!fabricCanvas) return;

        const objectsJson = Array.isArray(snapshot) ? snapshot : [];
        const prevRenderOnAddRemove = fabricCanvas.renderOnAddRemove;
        fabricCanvas.renderOnAddRemove = false;
        fabricCanvas.discardActiveObject();

        fabricCanvas.getObjects().slice().forEach(obj => fabricCanvas.remove(obj));

        const instances = await Promise.all(
            objectsJson.map(async (objJson) => {
                if (objJson?.type === 'rect') return fromObjectAsync(Rect, objJson);
                if (objJson?.type === 'path' || objJson?.type === 'Path') return fromObjectAsync(Path, objJson);
                return null;
            })
        );

        instances.filter(Boolean).forEach(obj => {
            obj.set({ selectable, evented: selectable });
            fabricCanvas.add(obj);
        });

        fabricCanvas.renderOnAddRemove = prevRenderOnAddRemove;
        fabricCanvas.requestRenderAll();
        syncRegions();
    };

    const undo = () => {
        const nextStep = historyStepRef.current - 1;
        if (!fabricCanvas || nextStep < 0) return;

        const token = ++restoreTokenRef.current;
        historyStepRef.current = nextStep;
        setHistoryStep(nextStep);
        setIsRestoring(true);

        // 让出一帧，先把“回撤中…”等 UI 渲染出来，避免用户感知为“画面消失/卡死”
        requestAnimationFrame(() => {
            if (token !== restoreTokenRef.current) return;
            Promise.resolve(restoreObjectsFromSnapshot(historyRef.current[nextStep], drawMode === 'select')).finally(() => {
                if (token === restoreTokenRef.current) setIsRestoring(false);
            });
        });
    };

    const redo = () => {
        const nextStep = historyStepRef.current + 1;
        if (!fabricCanvas || nextStep >= historyRef.current.length) return;

        const token = ++restoreTokenRef.current;
        historyStepRef.current = nextStep;
        setHistoryStep(nextStep);
        setIsRestoring(true);

        requestAnimationFrame(() => {
            if (token !== restoreTokenRef.current) return;
            Promise.resolve(restoreObjectsFromSnapshot(historyRef.current[nextStep], drawMode === 'select')).finally(() => {
                if (token === restoreTokenRef.current) setIsRestoring(false);
            });
        });
    };

    const clearCanvas = () => {
        if (!fabricCanvas) return;
        fabricCanvas.getObjects().slice().forEach(obj => fabricCanvas.remove(obj));
        fabricCanvas.requestRenderAll();
        pushHistory();
        syncRegions();
    };

    // 键盘快捷键：撤销/重做、删除选中、取消框选
    useEffect(() => {
        if (!fabricCanvas) return;

        const isTypingTarget = (target) => {
            const el = target;
            if (!el) return false;
            if (el.isContentEditable) return true;
            const tag = (el.tagName || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select';
        };

        const onKeyDown = (e) => {
            if (isTypingTarget(e.target)) return;

            const isMod = e.ctrlKey || e.metaKey;
            const key = (e.key || '').toLowerCase();

            if (key === 'escape') {
                if (currentRectRef.current) {
                    fabricCanvas.remove(currentRectRef.current);
                    currentRectRef.current = null;
                }
                isRectDrawingRef.current = false;
                rectStartPointRef.current = null;
                scheduleRectInfoUpdate(null);
                fabricCanvas.requestRenderAll();
                return;
            }

            if (isMod && key === 'z' && !e.shiftKey) {
                e.preventDefault();
                if (!isRestoring) undo();
                return;
            }

            if ((isMod && key === 'y') || (isMod && key === 'z' && e.shiftKey)) {
                e.preventDefault();
                if (!isRestoring) redo();
                return;
            }

            if ((key === 'delete' || key === 'backspace') && drawMode === 'select') {
                const active = fabricCanvas.getActiveObjects();
                if (!active || active.length === 0) return;
                e.preventDefault();
                active.forEach(obj => fabricCanvas.remove(obj));
                fabricCanvas.discardActiveObject();
                fabricCanvas.requestRenderAll();
                pushHistory();
            }
        };

        window.addEventListener('keydown', onKeyDown, { passive: false });
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [fabricCanvas, drawMode, isRestoring]);

    // 空格拖拽平移（不影响场景坐标，只改变 viewportTransform）
    useEffect(() => {
        if (!fabricCanvas) return;

        const isTypingTarget = (target) => {
            const el = target;
            if (!el) return false;
            if (el.isContentEditable) return true;
            const tag = (el.tagName || '').toLowerCase();
            return tag === 'input' || tag === 'textarea' || tag === 'select';
        };

        const updateCursor = () => {
            if (isPanningRef.current) {
                fabricCanvas.defaultCursor = 'grabbing';
                return;
            }
            if (spacePressedRef.current) {
                fabricCanvas.defaultCursor = 'grab';
                return;
            }
            fabricCanvas.defaultCursor = 'default';
        };

        const onKeyDown = (e) => {
            if (isTypingTarget(e.target)) return;
            if (e.code !== 'Space') return;
            if (spacePressedRef.current) return;
            e.preventDefault();
            spacePressedRef.current = true;
            if (fabricCanvas.isDrawingMode) fabricCanvas.isDrawingMode = false;
            updateCursor();
        };

        const onKeyUp = (e) => {
            if (e.code !== 'Space') return;
            spacePressedRef.current = false;
            isPanningRef.current = false;
            lastPanClientRef.current = null;
            // 释放空格后恢复当前工具的绘制状态
            fabricCanvas.isDrawingMode = (drawMode === 'brush' || drawMode === 'eraser') && !!isDrawing;
            updateCursor();
        };

        window.addEventListener('keydown', onKeyDown, { passive: false });
        window.addEventListener('keyup', onKeyUp);
        updateCursor();
        return () => {
            window.removeEventListener('keydown', onKeyDown);
            window.removeEventListener('keyup', onKeyUp);
        };
    }, [fabricCanvas, drawMode, isDrawing]);

    // 初始化 fabric canvas
    useEffect(() => {
        if (!canvasRef.current || !containerRef.current) return;

        const canvas = new Canvas(canvasRef.current, {
            isDrawingMode: false,
            selection: false,
            backgroundColor: '#F2F2F7',
            preserveObjectStacking: true,
            enableRetinaScaling: false,
        });

        setFabricCanvas(canvas);
        onCanvasReady?.(canvas);

        return () => {
            if (pointerRafRef.current) cancelAnimationFrame(pointerRafRef.current);
            canvas.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // 让画布始终填满容器（视口），图片通过 viewportTransform 居中/缩放显示
    useEffect(() => {
        if (!fabricCanvas) return;

        const container = containerRef.current;
        if (!container) return;

        const resizeToContainer = () => {
            const w = container.clientWidth;
            const h = container.clientHeight;
            if (!w || !h) return;
            fabricCanvas.setDimensions({ width: w, height: h }, { cssOnly: false });
            fabricCanvas.calcOffset();
            if (viewModeRef.current === 'fit') fitToView();
            if (viewModeRef.current === '1:1') resetTo1to1();
        };

        resizeToContainer();
        const ro = new ResizeObserver(() => resizeToContainer());
        ro.observe(container);
        window.addEventListener('resize', resizeToContainer);
        return () => {
            ro.disconnect();
            window.removeEventListener('resize', resizeToContainer);
        };
    }, [fabricCanvas]);

    // 加载图片：自动“适应窗口 + 居中显示全貌”，不改变场景坐标（场景坐标=原图像素坐标）
    useEffect(() => {
        if (!fabricCanvas || !imageUrl) return;

        const token = ++imageLoadTokenRef.current;
        FabricImage.fromURL(imageUrl, { crossOrigin: 'anonymous' })
            .then((img) => {
                if (token !== imageLoadTokenRef.current) return;
                imageInfoRef.current = { width: img.width, height: img.height };
                nextRegionIdRef.current = 1;

                img.set({
                    scaleX: 1,
                    scaleY: 1,
                    originX: 'left',
                    originY: 'top',
                    left: 0,
                    top: 0,
                });

                fabricCanvas.clear();
                fabricCanvas.backgroundColor = '#F2F2F7';
                fabricCanvas.backgroundImage = img;
                // 限制绘制/导出只发生在图片区域，避免“画到图片外”造成坐标与导出混乱
                fabricCanvas.clipPath = new Rect({
                    left: 0,
                    top: 0,
                    width: img.width,
                    height: img.height,
                    originX: 'left',
                    originY: 'top',
                    absolutePositioned: true,
                    selectable: false,
                    evented: false,
                });
                fabricCanvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
                fabricCanvas.requestRenderAll();
                fabricCanvas.calcOffset();

                resetHistory();
                scheduleRectInfoUpdate(null);
                onRegionsChange?.([]);
                viewModeRef.current = 'fit';
                // 下一帧再 fit，确保容器尺寸已同步
                requestAnimationFrame(() => fitToView());
            })
            .catch((err) => {
                console.error('加载图片失败:', err);
            });
    }, [fabricCanvas, imageUrl]);

    // 滚轮缩放：以鼠标位置为中心缩放，保持场景坐标不漂移
    useEffect(() => {
        if (!fabricCanvas) return;

        const onWheel = (opt) => {
            const e = opt.e;
            if (!e) return;
            e.preventDefault();

            const currentZoom = fabricCanvas.getZoom();
            const factor = Math.pow(1.0015, -e.deltaY);
            const nextZoom = clamp(currentZoom * factor, 0.05, 32);
            const vpPoint = fabricCanvas.getViewportPoint(e);
            fabricCanvas.zoomToPoint(vpPoint, nextZoom);
            fabricCanvas.requestRenderAll();
            fabricCanvas.calcOffset();
            setZoom(nextZoom);
            viewModeRef.current = 'manual';
        };

        fabricCanvas.on('mouse:wheel', onWheel);
        return () => fabricCanvas.off('mouse:wheel', onWheel);
    }, [fabricCanvas]);

    // 工具模式切换与事件绑定
    useEffect(() => {
        if (!fabricCanvas) return;

        const prev = handlersRef.current;
        if (prev.mouseDown) fabricCanvas.off('mouse:down', prev.mouseDown);
        if (prev.mouseMove) fabricCanvas.off('mouse:move', prev.mouseMove);
        if (prev.mouseUp) fabricCanvas.off('mouse:up', prev.mouseUp);
        if (prev.pathCreated) fabricCanvas.off('path:created', prev.pathCreated);

        isRectDrawingRef.current = false;
        rectStartPointRef.current = null;
        scheduleRectInfoUpdate(null);
        if (currentRectRef.current) {
            fabricCanvas.remove(currentRectRef.current);
            currentRectRef.current = null;
        }

        const startPanning = (nativeEvent) => {
            isPanningRef.current = true;
            lastPanClientRef.current = { x: nativeEvent.clientX, y: nativeEvent.clientY };
            fabricCanvas.defaultCursor = 'grabbing';
        };

        const stopPanning = () => {
            isPanningRef.current = false;
            lastPanClientRef.current = null;
            fabricCanvas.defaultCursor = spacePressedRef.current ? 'grab' : 'default';
        };

        const selectable = drawMode === 'select';
        fabricCanvas.isDrawingMode = false;
        fabricCanvas.selection = selectable;
        setAllObjectsSelectable(fabricCanvas, selectable);

        let toolMouseDown = null;
        let toolMouseMove = null;
        let toolMouseUp = null;
        const nextHandlers = { mouseDown: null, mouseMove: null, mouseUp: null, pathCreated: null };

        if (drawMode === 'brush') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = !!isDrawing;

            if (isDrawing) {
                const brush = new PencilBrush(fabricCanvas);
                brush.color = 'rgba(255, 0, 0, 0.5)';
                brush.width = brushSize;
                fabricCanvas.freeDrawingBrush = brush;

                nextHandlers.pathCreated = () => pushHistory();
            }
        }

        if (drawMode === 'eraser') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = !!isDrawing;

            if (isDrawing) {
                const brush = new PencilBrush(fabricCanvas);
                brush.width = brushSize;
                brush.color = 'rgba(0, 0, 0, 1)';
                fabricCanvas.freeDrawingBrush = brush;

                nextHandlers.pathCreated = (e) => {
                    const erasePath = e.path;
                    const objects = fabricCanvas.getObjects().slice();
                    objects.forEach(obj => {
                        if (obj === erasePath) return;
                        if (obj.type === 'path' || obj.type === 'rect') {
                            if (obj.intersectsWithObject(erasePath)) fabricCanvas.remove(obj);
                        }
                    });
                    fabricCanvas.remove(erasePath);
                    fabricCanvas.requestRenderAll();
                    pushHistory();
                };
            }
        }

        if (drawMode === 'rectangle') {
            fabricCanvas.selection = false;
            setAllObjectsSelectable(fabricCanvas, false);
            fabricCanvas.isDrawingMode = false;

            toolMouseDown = (e) => {
                if (!isDrawing) return;
                const pt = clampPointToImage(fabricCanvas.getScenePoint(e.e));
                schedulePointerUpdate(pt);

                rectStartPointRef.current = pt;
                isRectDrawingRef.current = true;

                const rect = new Rect({
                    left: pt.x,
                    top: pt.y,
                    width: 0,
                    height: 0,
                    originX: 'left',
                    originY: 'top',
                    centeredScaling: false,
                    fill: 'rgba(255, 0, 0, 0.3)',
                    stroke: 'rgba(255, 0, 0, 0.8)',
                    strokeWidth: 2,
                    selectable: false,
                    evented: false,
                });
                rect.regionId = nextRegionIdRef.current++;

                currentRectRef.current = rect;
                fabricCanvas.add(rect);
                scheduleRectInfoUpdate({ x: rect.left, y: rect.top, width: 0, height: 0 });
                fabricCanvas.requestRenderAll();
            };

            toolMouseMove = (e) => {
                const pt = clampPointToImage(fabricCanvas.getScenePoint(e.e));
                schedulePointerUpdate(pt);
                if (!isRectDrawingRef.current || !currentRectRef.current || !rectStartPointRef.current) return;

                const start = rectStartPointRef.current;
                let width = Math.abs(pt.x - start.x);
                let height = Math.abs(pt.y - start.y);

                if (e.e.shiftKey) {
                    const size = Math.max(width, height);
                    width = size;
                    height = size;
                }

                const left = Math.min(pt.x, start.x);
                const top = Math.min(pt.y, start.y);

                currentRectRef.current.set({ left, top, width, height });
                currentRectRef.current.setCoords();
                scheduleRectInfoUpdate({ x: left, y: top, width, height });
                fabricCanvas.requestRenderAll();
            };

            toolMouseUp = () => {
                if (!isRectDrawingRef.current) return;
                isRectDrawingRef.current = false;

                const rect = currentRectRef.current;
                currentRectRef.current = null;
                rectStartPointRef.current = null;

                if (!rect || rect.width < 1 || rect.height < 1) {
                    if (rect) fabricCanvas.remove(rect);
                    scheduleRectInfoUpdate(null);
                    fabricCanvas.requestRenderAll();
                    syncRegions();
                    return;
                }

                scheduleRectInfoUpdate({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
                pushHistory();
                syncRegions();
            };
        }

        nextHandlers.mouseDown = (e) => {
            if (spacePressedRef.current) {
                startPanning(e.e);
                viewModeRef.current = 'manual';
                return;
            }
            toolMouseDown?.(e);
        };

        nextHandlers.mouseMove = (e) => {
            const pt = fabricCanvas.getScenePoint(e.e);
            schedulePointerUpdate(pt);

            if (isPanningRef.current) {
                const last = lastPanClientRef.current;
                if (!last) {
                    lastPanClientRef.current = { x: e.e.clientX, y: e.e.clientY };
                    return;
                }
                const dx = e.e.clientX - last.x;
                const dy = e.e.clientY - last.y;
                lastPanClientRef.current = { x: e.e.clientX, y: e.e.clientY };

                const vpt = [...fabricCanvas.viewportTransform];
                vpt[4] += dx;
                vpt[5] += dy;
                fabricCanvas.setViewportTransform(vpt);
                fabricCanvas.requestRenderAll();
                fabricCanvas.calcOffset();
                setZoom(fabricCanvas.getZoom());
                viewModeRef.current = 'manual';
                return;
            }

            toolMouseMove?.(e);
        };

        nextHandlers.mouseUp = (e) => {
            if (isPanningRef.current) {
                stopPanning();
                return;
            }
            toolMouseUp?.(e);
        };

        handlersRef.current = nextHandlers;
        if (nextHandlers.mouseDown) fabricCanvas.on('mouse:down', nextHandlers.mouseDown);
        if (nextHandlers.mouseMove) fabricCanvas.on('mouse:move', nextHandlers.mouseMove);
        if (nextHandlers.mouseUp) fabricCanvas.on('mouse:up', nextHandlers.mouseUp);
        if (nextHandlers.pathCreated) fabricCanvas.on('path:created', nextHandlers.pathCreated);
    }, [fabricCanvas, drawMode, isDrawing, brushSize]);

    // 监听对象变化（移动/缩放等）同步区域列表
    useEffect(() => {
        if (!fabricCanvas) return;
        const onChanged = () => syncRegions();
        fabricCanvas.on('object:modified', onChanged);
        fabricCanvas.on('object:added', onChanged);
        fabricCanvas.on('object:removed', onChanged);
        return () => {
            fabricCanvas.off('object:modified', onChanged);
            fabricCanvas.off('object:added', onChanged);
            fabricCanvas.off('object:removed', onChanged);
        };
    }, [fabricCanvas]);

    const hudText = useMemo(() => {
        const parts = [];
        parts.push(pointer ? `X: ${Math.round(pointer.x)}  Y: ${Math.round(pointer.y)}` : 'X: -  Y: -');
        parts.push(`缩放: ${Math.round(zoom * 100)}%`);
        if (rectInfo) {
            parts.push(
                `框选: X ${Math.round(rectInfo.x)}  Y ${Math.round(rectInfo.y)}  W ${Math.round(rectInfo.width)}  H ${Math.round(rectInfo.height)}`
            );
        }
        if (isRestoring) parts.push('回撤中…');
        if (!isDrawing && drawMode !== 'select') parts.push('绘制未启用（点击左侧按钮或点工具自动启用）');
        parts.push('空格拖拽平移 · 滚轮缩放');
        return parts.join('  ·  ');
    }, [pointer, zoom, rectInfo, isRestoring, isDrawing, drawMode]);

    return (
        <div className="relative w-full h-full flex flex-col">
            <div
                ref={containerRef}
                className="flex-1 w-full h-full rounded-ios-md overflow-hidden bg-white/50 shadow-inner-cut"
            >
                <canvas ref={canvasRef} className="block" />
            </div>

            <div className="absolute top-4 left-4 flex items-center gap-2">
                <div className="px-3 py-1.5 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50 text-xs text-slate-700 select-none">
                    {hudText}
                </div>
                <div className="flex items-center gap-2 p-1 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={fitToView}
                        title="适应窗口并居中显示全貌"
                    >
                        适应窗口
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={resetTo1to1}
                        title="恢复 1:1（不放大）"
                    >
                        1:1
                    </Button>
                    <Button
                        variant="ghost"
                        size="sm"
                        className="rounded-full"
                        onClick={() => {
                            if (!rectInfo) return;
                            const text = `${Math.round(rectInfo.x)},${Math.round(rectInfo.y)},${Math.round(rectInfo.width)},${Math.round(rectInfo.height)}`;
                            copyToClipboard(text);
                        }}
                        disabled={!rectInfo}
                        title="复制框选坐标（x,y,w,h）"
                    >
                        复制框选
                    </Button>
                </div>
            </div>

            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 flex flex-col items-center gap-3">
                {(drawMode === 'brush' || drawMode === 'eraser') && (
                    <div className="px-4 py-2 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                        <div className="flex items-center gap-3">
                            <span className="text-xs font-medium text-slate-600">画笔大小</span>
                            <input
                                type="range"
                                min="5"
                                max="100"
                                value={brushSize}
                                onChange={(e) => setBrushSize(Number(e.target.value))}
                                className="w-32"
                            />
                            <span className="text-xs font-medium text-slate-900 w-8">{brushSize}</span>
                        </div>
                    </div>
                )}

                <div className="flex items-center gap-2 p-2 bg-white/90 backdrop-blur-glass-60 rounded-full shadow-lg border border-white/50">
                    <Button
                        variant={drawMode === 'select' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('select');
                            setIsDrawing?.(false);
                        }}
                        className="rounded-full w-10 h-10"
                        title="选择工具"
                    >
                        <MousePointer2 size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'brush' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('brush');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="画笔"
                    >
                        <Pencil size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'rectangle' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('rectangle');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="矩形框选（按住 Shift 画正方形）"
                    >
                        <Square size={18} />
                    </Button>

                    <Button
                        variant={drawMode === 'eraser' ? 'primary' : 'ghost'}
                        size="icon"
                        onClick={() => {
                            setDrawMode('eraser');
                            setIsDrawing?.(true);
                        }}
                        className="rounded-full w-10 h-10"
                        title="橡皮擦"
                    >
                        <Eraser size={18} />
                    </Button>

                    <div className="w-px h-6 bg-gray-300 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10"
                        onClick={undo}
                        disabled={historyStep <= 0 || isRestoring}
                        title="撤销"
                    >
                        <Undo2 size={18} />
                    </Button>

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10"
                        onClick={redo}
                        disabled={historyStep >= historyLength - 1 || isRestoring}
                        title="重做"
                    >
                        <Redo2 size={18} />
                    </Button>

                    <div className="w-px h-6 bg-gray-300 mx-1" />

                    <Button
                        variant="ghost"
                        size="icon"
                        className="rounded-full w-10 h-10 text-red-500 hover:bg-red-50"
                        onClick={clearCanvas}
                        title="清空遮罩"
                    >
                        <Trash2 size={18} />
                    </Button>
                </div>
            </div>
        </div>
    );
}
