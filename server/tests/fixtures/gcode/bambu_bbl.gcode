; HEADER_BLOCK_START
; BambuStudio 01.10.01.50
; model printing time: 26s; total estimated time: 6m 9s
; total layer number: 1
; total filament length [mm] : 20.12
; total filament weight [g] : 0.06
; HEADER_BLOCK_END

; CONFIG_BLOCK_START
; printer_model = Bambu Lab A1 mini
; nozzle_diameter = 0.4
; filament_type = PLA
; filament_colour = #ECA514FF
; layer_height = 0.2
; printer_settings_id = "Bambu Lab A1 mini 0.4 nozzle"
; filament_settings_id = "Bambu PLA Basic @BBL A1M"
; curr_bed_type = Textured PEI Plate
; CONFIG_BLOCK_END

; EXECUTABLE_BLOCK_START
G28
G1 Z5 F5000
G1 X10 Y10 F3000
G1 X20 Y20
G1 X30 Y30
G1 X40 Y40
G1 X50 Y50
G1 Z0.2
M104 S0
M140 S0
; EXECUTABLE_BLOCK_END
