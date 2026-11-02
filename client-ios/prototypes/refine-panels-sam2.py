"""THROWAWAY: refine vision polygons with local SAM 2.1, no image generation.
Run with the temporary SAM environment: python <script> <state.json> <checkpoint> <output-dir>
All prompts derive from model polygons. No garment-specific hand-set coordinates.
"""
import base64, io, json, sys, time
from pathlib import Path
import numpy as np
from PIL import Image, ImageDraw, ImageFilter
import torch
from sam2.build_sam import build_sam2
from sam2.sam2_image_predictor import SAM2ImagePredictor
state_path, checkpoint, output = sys.argv[1:]
out=Path(output); out.mkdir(parents=True,exist_ok=True)
torch.set_num_threads(4)
predictor=SAM2ImagePredictor(build_sam2('configs/sam2.1/sam2.1_hiera_t.yaml',checkpoint,device='cpu',apply_postprocessing=False))
report=[]
def core_points(mask, count=5):
    eroded=np.asarray(Image.fromarray(mask.astype(np.uint8)*255).filter(ImageFilter.MinFilter(21)))>128
    ys,xs=np.where(eroded)
    if len(xs)<10: return []
    points=[]
    for y in np.linspace(np.quantile(ys,.12),np.quantile(ys,.88),count):
        near=(abs(ys-y)<=3)
        if near.any(): points.append([float(np.median(xs[near])),float(np.median(ys[near]))])
    return points
for name in ['hoodie','tee','printed-tee']:
    v=json.loads(Path(state_path).read_text())['variants'][name]
    source=Image.open(io.BytesIO(base64.b64decode(v['source']))).convert('RGB');image=np.array(source);h,w=image.shape[:2]
    coarse={}
    for part in v['segmentation']['parts']:
        m=Image.new('L',(w,h));ImageDraw.Draw(m).polygon([(x*w/1000,y*h/1000)for x,y in part['polygon']],fill=255)
        coarse[part['name']]=np.asarray(m)>128
    start=time.monotonic()
    with torch.inference_mode():
        predictor.set_image(image)
        for side in ['left_sleeve','right_sleeve']:
            prior=coarse[side];ys,xs=np.where(prior);positive=core_points(prior)
            negative=core_points(coarse['torso'],4)+core_points(coarse['right_sleeve' if side=='left_sleeve' else 'left_sleeve'],3)
            points=np.array(positive+negative,dtype=np.float32);labels=np.array([1]*len(positive)+[0]*len(negative),dtype=np.int32)
            box=np.array([max(0,xs.min()-15),max(0,ys.min()-15),min(w-1,xs.max()+15),min(h-1,ys.max()+15)])
            masks,scores,logits=predictor.predict(point_coords=points,point_labels=labels,box=box,multimask_output=True)
            masks=masks>0.5
            ranking=[]
            for mask,score in zip(masks,scores):
                iou=float((mask&prior).sum()/max(1,(mask|prior).sum()))
                ranking.append(iou+.2*float(score))
            i=int(np.argmax(ranking));mask=masks[i]
            Image.fromarray(mask.astype(np.uint8)*255).save(out/f'{name}-{side}-mask.png')
            rgba=np.dstack([image,mask.astype(np.uint8)*255]);Image.fromarray(rgba).save(out/f'{name}-{side}.png')
            overlay=image.copy();colour=np.array([40,130,255]if side=='left_sleeve'else[255,120,35]);overlay[mask]=(overlay[mask]*.65+colour*.35).astype(np.uint8)
            view=Image.fromarray(overlay);draw=ImageDraw.Draw(view)
            for (x,y),label in zip(points,labels):draw.ellipse((x-4,y-4,x+4,y+4),fill='lime'if label else'red')
            view.save(out/f'{name}-{side}-overlay.png')
            report.append(dict(name=name,side=side,scores=scores.tolist(),ranking=ranking,selected=i,pixels=int(mask.sum()),priorPixels=int(prior.sum())))
    print(json.dumps(dict(name=name,seconds=round(time.monotonic()-start,2))),flush=True)
(out/'report.json').write_text(json.dumps(report,indent=2))
