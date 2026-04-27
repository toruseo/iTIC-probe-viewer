Thailand vehicles and mobile probe data

Copyright 2018-Now by iTIC -- Intelligent Traffic Information Center (https://www.iticfoundation.org/).

This work is licensed under the Creative Commons Attribution 4.0 International License.
To view a copy of this license, visit http://creativecommons.org/licenses/by/4.0/ or send a letter to Creative Commons, PO Box 1866, Mountain View, CA 94042, USA.

Format description (please refer to http://traffic.longdo.com/docs/probedata-format):

Probe data of each day is saved in a CSV text file with the following structure:

Example of CSV file content:

wAwKpIfvv077zeaMM+nbSi09bHg,1,13.72878,100.49035,2016-12-31 23:59:27,0,331,0,0
hgzoCSq3DmCzsq7gjDkL1vWmuwc,1,13.93083,100.60743,2016-12-31 23:59:40,48,27,0,1
eknoba7CnGxjhTpmq531Im/Rx7s,1,13.79902,100.36575,2016-12-31 23:58:56,0,263,1,0

Fields description:

VehicleID,gpsvalid,lat,lon,timestamp,speed,heading,for_hire_light,engine_acc

Vehicle ID: Unique vehicle ID
GPS Valid: 1 = enough satellite for GPS fix
lat / lon: GPS location up to 5 decimal places
timestamp: GPS timestamp ( GMT+7 )
speed: km/h
heading: vehicle heading direction [0-360) degree from North=0
for_hire_light: [for taxis] whether "For Hire" light is ON
                1 = light on  => possibly no passenger
                0 = light off => possibly carrying passengers
engine_acc: car key status active, can be:
                1 (active, the data will be collected every minutes) or
                0 (inactive, data collected every 3 minutes)
