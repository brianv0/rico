import json, sys
d = json.load(open(sys.argv[1]))
tpl = open(sys.argv[2]).read()
light_names = ['NeutralDefault', 'NeutralGrey', 'FlagshipTerrastruct', 'CoolClassics', 'MixedBerryBlue', 'GrapeSoda', 'Aubergine', 'ColorblindClear',
               'VanillaNitroCola', 'OrangeCreamsicle', 'ShirleyTemple', 'EarthTones', 'EvergladeGreen', 'ButteredToast', 'Terminal', 'TerminalGrayscale', 'Origami', 'C4']
dark_names = ['DarkMauve', 'DarkFlagshipTerrastruct']
assert len(light_names) == len(d['light']) and len(dark_names) == len(d['dark'])
out = ''
for n, t in zip(light_names + dark_names, d['light'] + d['dark']):
    out += 'export const %s = %s;\n\n' % (n, json.dumps(t).replace('"', "'") if False else json.dumps(t))
neutrals = ''
for k, v in d['neutrals'].items():
    neutrals += 'export const %s = %s;\n' % (k, json.dumps(v))
tpl = tpl.replace('/*NEUTRALS*/', neutrals).replace('/*THEMES*/', out).replace('/*LIGHT*/', ', '.join(light_names)).replace('/*DARK*/', ', '.join(dark_names))
tpl = tpl.replace('/*ZERO*/', json.dumps(d['zero']))
open(sys.argv[3], 'w').write(tpl)
